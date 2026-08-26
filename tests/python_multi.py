"""WHAT PYTHON ASKS FOR, AND WHETHER THE PAGE DOES IT.

    python3 tests/python_multi.py

Everything here is a setting that reached the config correctly and then did
nothing, which is the failure this file exists to catch - the picture and the
state disagreeing, with nothing raising:

  * `view(multi=True)` / `view.show_objects([...])` - several structures in one
    picture, a different question from `overlay=True` (every FRAME of one);
  * `view.orient(...)` - turn the camera onto a selection, which the first
    frame does unprompted and nothing could ask for again;
  * the picker row, which a shell with ONE object should not show at all;
  * `view(rotate=True)`, which the viewer's own opening orient switched off;
  * `bg` with `box=False`, where turning the frame off repainted the paper -
    and `py2Dmol.grid` defaults `box` to False;
  * the Cyclic toggle, which the shared Style panel showed in every shell and
    only the website wired;
  * and the layout BEFORE ANY SCRIPT RUNS, which is what Colab measures when
    it sizes an output frame.

One page, several viewers, because each needs a different page state and a
Chrome start costs more than the measurements do. `check_live()` covers the
live path in Python alone, with no browser.

IPython is stubbed when it is absent: the module imports it at load time, and
nothing here displays anything.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_pymulti.html')

try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, n, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import numpy as np  # noqa: E402
import py2Dmol  # noqa: E402


# A HELIX AND THE SAME HELIX A LONG WAY OFF. Far enough apart that framing one
# of them is a visibly different camera from framing both - which is the whole
# of what the orient check below measures.
def helix(dx=0.0):
    pts = []
    for i in range(30):
        t = i * 100.0 * np.pi / 180.0
        pts.append([dx + 2.3 * np.cos(t), 2.3 * np.sin(t), 1.5 * i])
    return np.array(pts, dtype=float)


def _live_blocks(v):
    """Every `viewer` block this viewer has emitted since the last call."""
    out = []
    for html in v._emitted:
        m = re.search(r'const p=(\{.*?\});', html, re.S)
        if m:
            blk = json.loads(m.group(1)).get('viewer')
            if blk is not None:
                out.append(blk)
    v._emitted.clear()
    return out


def check_live():
    """THE LIVE PATH, IN PYTHON ALONE.

    What reaches a viewer that is already on screen travels in the `viewer`
    block beside `frames` and `meta`, and this is the packing half of it -
    tests/config.js checks that parts/ui.js reads every key packed here, and
    the browser half above checks the appliers themselves.

    Three behaviours that are not obvious from the code:
      * shown_objects is DIFFED, so asking for what is already showing emits
        nothing - a resend would reframe the camera for no reason;
      * orient is NOT, because the same request twice means fly there twice;
      * multi=True is a standing instruction rather than a list, so an object
        added after show() joins what is drawn.
    """
    bad = []
    v = py2Dmol.view((200, 200))
    v._emitted = []
    v._emit_to_output = lambda html, payload_json=None, update_last_add=False: \
        v._emitted.append(html)
    v.add(helix(), name='a', align=False)
    v.add(helix(120.0), name='b', align=False)
    #  ...THROUGH show(), because that is where the "already sent" marks are
    #  set. Without it the first live update also carries `clip: None`, which
    #  is correct - nothing has told the page yet - and would read here as
    #  show_objects emitting something it did not.
    v._display_viewer(static_data=v.objects)
    v._is_live = True
    v._emitted.clear()

    v.show_objects(['a', 'b'])
    got = _live_blocks(v)
    if got != [{'shown_objects': ['a', 'b']}]:
        bad.append(f'show_objects on a live viewer emitted {got}')
    v.show_objects(['a', 'b'])
    if _live_blocks(v):
        bad.append('asking for the objects already on screen emitted an update'
                   ' - a resend reframes the camera for nothing')

    v.orient(chain='A')
    v.orient(chain='A')
    got = _live_blocks(v)
    want = {'chain': 'A', 'animate': True}
    if got != [{'orient': want}, {'orient': want}]:
        bad.append(f'orient is being diffed like a state: {got} - the same'
                   ' request twice means fly there twice')

    #  ...AND THE FLAG KEEPS UP WITH add(). A viewer opened with multi=True
    #  drew what existed at show() time and then quietly stopped accepting
    #  new objects, which reads as "the third structure did not load".
    m = py2Dmol.view((200, 200), multi=True)
    m._emitted = []
    m._emit_to_output = lambda html, payload_json=None, update_last_add=False: \
        m._emitted.append(html)
    m.add(helix(), name='a', align=False)
    m._display_viewer(static_data=m.objects)
    m._is_live = True
    m._emitted.clear()
    m.add(helix(120.0), name='b', align=False)
    got = [g for g in _live_blocks(m) if 'shown_objects' in g]
    if got != [{'shown_objects': ['a', 'b']}]:
        bad.append(f'an object added to a live multi=True viewer did not join'
                   f' what is drawn: {got}')
    #  ...and naming a set replaces the standing instruction
    m.show_objects(['a'])
    m.add(helix(240.0), name='c', align=False)
    got = [g for g in _live_blocks(m) if 'shown_objects' in g]
    if got != [{'shown_objects': ['a']}]:
        bad.append(f'show_objects did not clear multi=True: {got} - the flag'
                   ' would put the next add() back on screen behind the'
                   " caller's back")
    # ...AND LEAVE NO MARK ON THE MODULE. _LENT_BUNDLE is process state: the
    # first viewer to reach _display_viewer writes the library and every later
    # one writes a request to borrow it. A check that builds a viewer here and
    # nowhere the page can see it would make the page's OWN first viewer a
    # borrower, with nothing on the page lending - a blank page and a dozen
    # unrelated failures.
    py2Dmol.viewer._LENT_BUNDLE = None
    return bad


def page():
    #  ONE object: the picker row has nothing to offer and must be gone.
    one = py2Dmol.view((300, 300), id='one')
    one.add(helix(), name='solo')

    #  TWO objects and multi=True: both drawn, the picker row back.
    both = py2Dmol.view((300, 300), id='both', multi=True)
    both.add(helix(), name='a', align=False)
    both.add(helix(120.0), name='b', align=False)

    #  TWO objects, one named, and a camera aimed at the OTHER one. Both are
    #  drawn so that "orient on a" and "orient on everything" are different
    #  cameras - with only one object on screen they are the same answer and
    #  the check would prove nothing.
    aimed = py2Dmol.view((300, 300), id='aimed')
    aimed.add(helix(), name='a', align=False)
    aimed.add(helix(120.0), name='b', align=False)
    aimed.show_objects()          # ...resolved to ['a', 'b'] here, in Python
    aimed.orient(name='a')

    assert both.config.get('shown_objects') is None, \
        'multi=True is resolved in _display_viewer, not before it'
    bodies = [v._display_viewer(static_data=v.objects) for v in (one, both, aimed)]
    assert both.config.get('shown_objects') == ['a', 'b'], \
        f"multi=True did not become a list of names: {both.config.get('shown_objects')}"
    assert aimed.config.get('shown_objects') == ['a', 'b'], \
        f"show_objects() did not resolve to every object: {aimed.config.get('shown_objects')}"
    assert aimed.config.get('orient') == {'object': 'a', 'animate': False}, \
        f"orient() did not put a selector in the config: {aimed.config.get('orient')}"
    assert one.config.get('shown_objects') is None and 'orient' not in one.config, \
        'a viewer that asked for neither must carry neither'

    #  A RING, FOR THE CYCLIC TOGGLE. parts/panel.js is one table and every
    #  shell mounts it, so the Cyclic box was on screen in the notebook and the
    #  embed - unchecked whatever cyclic said, and inert when clicked,
    #  because only src/app/main.js ever wired it. Twelve CA positions on a
    #  circle: the termini are within bonding range, so the ring closes into a
    #  twelfth bond and does not without.
    ring = np.array([[6.0 * np.cos(2 * np.pi * i / 12),
                      6.0 * np.sin(2 * np.pi * i / 12), 0.0] for i in range(12)])
    for name, kw in (('ring', {}), ('ringoff', {'cyclic': False})):
        rv = py2Dmol.view((240, 240), id=name, **kw)
        rv.add(ring, name='ring')
        bodies.append(rv._display_viewer(static_data=rv.objects))

    #  THE BOX IS THE FRAME AND bg IS THE PAPER, and turning the frame off used
    #  to repaint the paper: `box=False` set the canvas background to
    #  transparent AFTER the requested colour had been put on it, and told the
    #  renderer to clear transparent as well. py2Dmol.grid defaults box to
    #  FALSE, so `g.view(bg="black")` came out on white - which is how this was
    #  reported. The plain one beside it is the control: no colour asked for
    #  means a viewer that floats on whatever the page is, which is what
    #  box=False is for and must not change.
    paper = py2Dmol.view((200, 200), id='paper', bg='black', box=False)
    paper.add(helix(), name='solo')
    plain = py2Dmol.view((200, 200), id='plain', box=False)
    plain.add(helix(), name='solo')
    bodies.append(paper._display_viewer(static_data=paper.objects))
    bodies.append(plain._display_viewer(static_data=plain.objects))

    #  ...AND THE MARKUP ALONE, with no script having run. Colab inserts output
    #  HTML with innerHTML - which never executes a script - and sizes the
    #  output iframe from what it measures in that window. The stylesheet says
    #  the canvas box is 600x600 and parts/viewport.js corrects it, so a 2x2
    #  grid of 300px viewers was 1,220px of markup and the frame kept ~1,000px
    #  around a 644px page. Handed to the probe as a string and set with
    #  innerHTML there, which reproduces exactly that state.
    global PRESCRIPT
    bare = py2Dmol.view((300, 300), id='bare')
    bare.add(helix(), name='solo')
    PRESCRIPT = bare._display_viewer(static_data=bare.objects,
                                     include_libs=False)

    #  ...AND ONE THAT WAS ASKED TO TURN. rotate=True reached the config, the
    #  constructor and the checkbox and was then switched off again by the
    #  viewer's OWN opening orient, which stopped the spin unconditionally.
    turn = py2Dmol.view((300, 300), id='turn', rotate=True)
    turn.add(helix(), name='solo')
    assert turn.config['display']['rotate'] is True, \
        'rotate=True did not reach config.display'
    bodies.append(turn._display_viewer(static_data=turn.objects))
    return ''.join(bodies)


JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  const rot = (r) => r.viewerState.rotation.map(
      (row) => row.map((v) => Math.round(v * 1000) / 1000));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const go = async () => {
    const R = {errors: []};
    window.addEventListener('error', (e) => R.errors.push(String(e.message)));
    try {
      await settle(10);
      const vs = window.py2dmol_viewers || {};
      R.ids = Object.keys(vs);
      const read = (id) => {
        const r = vs[id].renderer;
        const sel = r.objectSelect;
        const row = sel && sel.closest ? sel.closest('.toggle-item') : null;
        return {
          objects: Object.keys(r.objectsData),
          drawn: r.drawnObjects(),
          merged: !!(r.multiState && r.multiState.enabled),
          n: r.coords.length,
          options: sel ? sel.options.length : -1,
          // ...the COMPUTED style, not the attribute: the row is hidden by
          // setting display on it, and reading the attribute back would pass
          // just as happily against a rule that never applied.
          rowShown: row ? getComputedStyle(row).display !== 'none' : null,
          rot: rot(r),
        };
      };
      R.one = read('one');
      R.both = read('both');
      R.aimed = read('aimed');

      //  THE CYCLIC TOGGLE, IN A SHELL THAT IS NOT THE WEBSITE. Its own
      //  checkbox, found by walking up from its canvas: every viewer on this
      //  page has one with the same id.
      const cycOf = (id) => {
        const r = vs[id].renderer;
        let e = r.canvas, cb = null;
        while (e && !(cb = e.querySelector
                && e.querySelector('#cyclicCheckbox'))) e = e.parentElement;
        return {r, cb,
                state: {box: !!cb, checked: cb ? cb.checked : null,
                        cfg: r.config.rendering.cyclic,
                        rings: r.cyclicChains ? r.cyclicChains.size : -1,
                        bonds: r.segmentIndices.filter(
                            (x) => x.type !== 'C').length}};
      };
      R.ring = cycOf('ring').state;
      R.ringOff = cycOf('ringoff').state;
      //  ...and it DOES something. The ring is closed in setCoords, not in
      //  render, so a repaint alone would change nothing.
      {
        const {r, cb} = cycOf('ring');
        if (cb) {
          cb.checked = false;
          cb.dispatchEvent(new Event('change', {bubbles: true}));
          await settle(6);
          R.ringAfter = {cfg: r.config.rendering.cyclic,
                         rings: r.cyclicChains ? r.cyclicChains.size : -1,
                         bonds: r.segmentIndices.filter(
                             (x) => x.type !== 'C').length};
        }
      }

      //  THE PAPER, READ OFF THE CANVAS. The corner pixel, with its ALPHA:
      //  transparent reads as (0,0,0,0) and black as (0,0,0,255), so a check
      //  on the colour alone cannot tell "painted black" from "painted
      //  nothing" - which is exactly the two states here.
      const paperOf = (id) => {
        const c = vs[id].renderer.canvas;
        const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
        return {px: [d[0], d[1], d[2], d[3]],
                css: getComputedStyle(c).backgroundColor};
      };
      R.paper = paperOf('paper');
      R.plain = paperOf('plain');

      //  THE LAYOUT BEFORE ANY SCRIPT RUNS. innerHTML does not execute
      //  scripts, so this IS the state Colab measures.
      {
        const holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:-4000px;top:0;width:900px';
        document.body.appendChild(holder);
        holder.innerHTML = window.__py2dmolPrescript;
        await settle();
        const cc = holder.querySelector('#canvasContainer');
        R.prescript = {
          height: Math.round(holder.getBoundingClientRect().height),
          box: cc ? [Math.round(cc.getBoundingClientRect().width),
                     Math.round(cc.getBoundingClientRect().height)] : null,
          ran: holder.querySelectorAll('canvas').length,
        };
        holder.remove();
      }

      //  ROTATE=TRUE ACTUALLY TURNS. Every surface orients itself when the
      //  first frame lands, and that orient stopped the spin - so a flag that
      //  reached the config, the constructor and the checkbox was unticked
      //  again before anyone saw it, with nothing in the trace looking wrong
      //  until the last line. The DELIBERATE orient still stops it, which is
      //  the second half below: a reader who presses Orient while it turns
      //  wants it framed and held.
      const rt = vs['turn'].renderer;
      const before = rot(rt);
      await new Promise((s) => setTimeout(s, 500));
      R.turn = {
        autoRotate: rt.autoRotate,
        //  THE RENDERER'S OWN ELEMENT, not a document lookup: four viewers
        //  on one page means four #rotationCheckbox nodes, and the first is
        //  another viewer's.
        checkbox: !!(rt.rotationCheckbox && rt.rotationCheckbox.checked),
        moved: !same(rot(rt), before),
      };
      //  ...AND ITS OWN BUTTON, found by walking UP from its canvas to the
      //  nearest ancestor that contains one. Four viewers on one page share
      //  every id, so a document lookup answers with the first viewer's.
      let shell = rt.canvas; let ob = null;
      while (shell && !(ob = shell.querySelector
              && shell.querySelector('#orientButton'))) {
        shell = shell.parentElement;
      }
      R.turn.hasButton = !!ob;
      if (ob) {
        ob.click();
        //  ...AFTER THE FLIGHT LANDS. The button animates over a second, so a
        //  sample taken during it measures the flight and reads as a spin
        //  that never stopped.
        await new Promise((s) => setTimeout(s, 1400));
        R.turn.autoRotateAfterOrient = rt.autoRotate;
        const held = rot(rt);
        await new Promise((s) => setTimeout(s, 500));
        R.turn.movedAfterOrient = !same(rot(rt), held);
      }

      // ...AND THE ROW COMES BACK when a second object does. Driven through
      // the renderer rather than by hand, because the question is whether
      // anything re-asks: a check that only ever sees the load-time state
      // cannot tell a rule that runs once from one that runs every time.
      const r1 = vs['one'].renderer;
      r1.addObject('second');
      r1.addFrame({coords: [[0, 0, 0], [3, 0, 0], [6, 0, 0]]}, 'second');
      await settle();
      const row1 = r1.objectSelect.closest('.toggle-item');
      R.oneAfter = {options: r1.objectSelect.options.length,
                    rowShown: getComputedStyle(row1).display !== 'none'};

      // THE CAMERA PYTHON ASKED FOR, against the two answers it could be.
      // Recomputed here from the identity so the comparison is between two
      // runs of the same search rather than against a matrix typed in.
      const ra = vs['aimed'].renderer;
      R.aimed.loadedRot = rot(ra);
      const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const redo = async (positions) => {
        ra.viewerState.rotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        ra.render('probe');
        await settle();
        window.py2dmolOrient.orientToBestView(ra, {positions, animate: false});
        await settle();
        return rot(ra);
      };
      R.aimed.onA = await redo(positionsFor(ra, {object: 'a'}));
      R.aimed.onAll = await redo(null);
      R.aimed.matchesA = same(R.aimed.loadedRot, R.aimed.onA);
      R.aimed.matchesAll = same(R.aimed.loadedRot, R.aimed.onAll);
      R.aimed.aDiffersFromAll = !same(R.aimed.onA, R.aimed.onAll);
      R.aimed.identity = same(R.aimed.loadedRot, I);
    } catch (e) { R.errors.push(String((e && e.stack) || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)


def main():
    #  THE PAGE FIRST. _LENT_BUNDLE is module state: the first viewer of a
    #  process writes the library and every later one borrows, so a viewer
    #  built before the page is built leaves all three of ITS viewers asking a
    #  page that has no lender on it. That is a blank page and eleven
    #  unrelated failures.
    body = page()
    #  ...ESCAPED, because the markup contains </script> and putting it in a
    #  <script> unescaped ends that script at the first one. viewer.py's lender
    #  does the same thing for the same reason.
    _hand = json.dumps(PRESCRIPT)
    for _bad in ('<script', '</script', '<!--'):
        _hand = _hand.replace(_bad, _bad.replace('<', '\\u003c'))
    hand = '<script>window.__py2dmolPrescript = ' + _hand + ';</script>'
    open(PROBE, 'w').write('<!doctype html><html><head><meta charset="utf-8">'
                           '</head><body>' + body + hand + JS + '</body></html>')
    bad = check_live()
    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a): pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
            self.send_response(200); self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9717), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=/tmp/py2dmol-pymulti',
                          '--no-first-run', '--window-size=900,1400',
                          'http://127.0.0.1:9717/_pymulti.html'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end:
        time.sleep(0.5)
    p.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree('/tmp/py2dmol-pymulti', ignore_errors=True)
    R = box[0] if box else {'errors': ['no result posted']}

    for k in ('one', 'both', 'aimed'):
        d = R.get(k) or {}
        print(f"  {k:6s} objects {d.get('objects')} drawn {d.get('drawn')}"
              f" merged {d.get('merged')} {d.get('n')} positions;"
              f" picker {d.get('options')} options, row shown {d.get('rowShown')}")
    print(f"  one, after a second object arrives: {R.get('oneAfter')}")
    a = R.get('aimed') or {}
    print(f"  orient: loaded {a.get('loadedRot')}")
    print(f"          on a  {a.get('onA')}  match {a.get('matchesA')}")
    print(f"          on all{a.get('onAll')}  match {a.get('matchesAll')}")

    for e in R.get('errors', []):
        bad.append('page error: ' + e)
    rg, ro, ra = (R.get('ring') or {}, R.get('ringOff') or {},
                  R.get('ringAfter') or {})
    print(f"  cyclic on {rg}; off {ro}; after unticking {ra}")
    if not rg.get('box'):
        bad.append('no Cyclic checkbox in this shell - parts/panel.js is one'
                   ' table and every shell mounts it')
    elif rg.get('bonds') != 12 or ro.get('bonds') != 11:
        bad.append(f"the ring fixture gives {rg.get('bonds')} bonds with"
                   f" cyclic on and {ro.get('bonds')} with it off - it"
                   ' has to differ by the closing bond or nothing below means'
                   ' anything')
    elif rg.get('checked') is not True or ro.get('checked') is not False:
        bad.append(f"the Cyclic box reads {rg.get('checked')} with"
                   f" cyclic on and {ro.get('checked')} with it off -"
                   ' it was never seeded from the config outside the website,'
                   ' so it came up unticked while the ring was closed')
    elif ra.get('bonds') != 11 or ra.get('cfg') is not False:
        bad.append(f"unticking Cyclic left {ra} - the control was on screen"
                   ' and inert, because only src/app/main.js wired it. The'
                   ' ring is closed in setCoords, so the frame has to be'
                   ' reloaded rather than repainted')

    pa, pl = R.get('paper') or {}, R.get('plain') or {}
    print(f"  bg=black box=False: {pa};  no bg, box=False: {pl}")
    if pa.get('px') != [0, 0, 0, 255]:
        bad.append(f"bg='black' with box=False painted {pa.get('px')} - the box"
                   ' is the frame and bg is the paper, and turning the frame'
                   ' off must not repaint the paper. grid defaults box to'
                   ' False, which is where this was reported')
    # ...AND THE ELEMENT'S OWN BACKGROUND, not just the painted pixel. The
    # renderer clears the drawing buffer and the CSS colours the element, and
    # either alone leaves the page showing through the other - a canvas that
    # is only painted flashes the page whenever it is resized or cleared. Both
    # have to say the same thing, and checking the pixel alone let two
    # separate mutations through.
    if pa.get('css') != 'rgb(0, 0, 0)':
        bad.append(f"the canvas element's background is {pa.get('css')} with"
                   " bg='black' - the renderer painted it but the element did"
                   ' not, so the page shows through on every resize')
    if pl.get('css') != 'rgba(0, 0, 0, 0)':
        bad.append(f"box=False with no colour left the element at"
                   f" {pl.get('css')} rather than transparent")
    if pl.get('px') != [0, 0, 0, 0]:
        bad.append(f"box=False with no colour asked for painted {pl.get('px')}"
                   ' - it should still float on the page, and if it does not'
                   ' the check above cannot tell the two apart')

    ps = R.get('prescript') or {}
    print(f"  before any script runs: {ps}")
    if ps.get('box') != [300, 300]:
        bad.append(f"the canvas box is {ps.get('box')} in the markup alone -"
                   ' the stylesheet says 600x600 and only a script corrects'
                   ' it, so Colab sizes the output frame from the wrong'
                   ' number and leaves white space under a grid')
    elif ps.get('height', 0) > 400:
        bad.append(f"an unsized 300px viewer is {ps.get('height')}px of markup")

    t = R.get('turn') or {}
    print(f"  rotate=True: {t}")
    if not t.get('autoRotate') or not t.get('checkbox'):
        bad.append(f"rotate=True came up with autoRotate {t.get('autoRotate')}"
                   f" and the checkbox {t.get('checkbox')} - the opening"
                   ' orient stops the spin, and it must not when nobody asked'
                   ' for the orient')
    if not t.get('moved'):
        bad.append('rotate=True did not turn the structure in half a second')
    if not t.get('hasButton'):
        bad.append('no Orient button on the turning viewer, so the half of the'
                   ' rule below is untested')
    elif t.get('autoRotateAfterOrient') or t.get('movedAfterOrient'):
        bad.append('pressing Orient left it spinning - a reader who asks for'
                   ' an angle while it turns wants it framed and held, and'
                   ' keepSpin is for the automatic orient alone')
    if R.get('ids') != ['one', 'both', 'aimed', 'ring', 'ringoff',
                        'paper', 'plain', 'turn']:
        bad.append(f"the three viewers did not all come up: {R.get('ids')}")

    one = R.get('one') or {}
    if one.get('options') != 1:
        bad.append(f"the one-object viewer has {one.get('options')} picker options")
    if one.get('rowShown') is not False:
        bad.append('a viewer with ONE object is still showing the picker row -'
                   ' a label and a dropdown that can only say what it already says')
    after = R.get('oneAfter') or {}
    if after.get('options') != 2 or after.get('rowShown') is not True:
        bad.append(f"the picker row did not come back with a second object: {after}"
                   ' - the rule has to be re-asked, not applied once at load')

    both = R.get('both') or {}
    if sorted(both.get('drawn') or []) != ['a', 'b']:
        bad.append(f"multi=True drew {both.get('drawn')} - the flag is resolved"
                   ' in _display_viewer, where the objects it names exist')
    if not both.get('merged'):
        bad.append('multi=True left the merge off, so the second object is in'
                   ' the config and not on the screen')
    if both.get('n') != 60:
        bad.append(f"two 30-position helices merged to {both.get('n')} positions")
    if both.get('rowShown') is not True:
        bad.append('two objects and no picker row - the hide above is'
                   ' unconditional, which is worse than never having it')

    aimed = R.get('aimed') or {}
    if sorted(aimed.get('drawn') or []) != ['a', 'b']:
        bad.append(f"show_objects() drew {aimed.get('drawn')}")
    if not aimed.get('aDiffersFromAll'):
        bad.append('framing object a and framing both objects came out as the'
                   ' same camera, so this fixture cannot tell them apart and'
                   ' the two checks below prove nothing')
    if aimed.get('identity'):
        bad.append('the aimed viewer opened at the identity rotation: nothing'
                   ' turned it at all')
    if not aimed.get('matchesA'):
        bad.append("orient(name='a') did not frame a: the camera came up at"
                   f" {aimed.get('loadedRot')} where framing a gives"
                   f" {aimed.get('onA')}")
    if aimed.get('matchesAll'):
        bad.append("orient(name='a') framed everything - the selector reached"
                   ' the page and was then ignored')

    if bad:
        print('FAIL')
        for b in bad:
            print('  - ' + b)
        return 1
    print('PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
