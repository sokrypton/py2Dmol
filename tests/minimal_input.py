"""The bare minimum: an Nx3 array of CA coordinates and nothing else.

    python3 tests/minimal_input.py

`view.add(coords)` is the Python API's smallest call - no chains, no residue
names, no atom names, no types, no side-chain table. Everything downstream has
to cope: the cartoon has to predict a backbone to build a ribbon from, the SS
assignment has to work off the trace, and the panel has to answer its
questions without inventing data it has not got.

It is also where a change made for the web app can quietly break the notebook:
the web loads a full PDB, so a reader that assumes atom names or a side-chain
table is present will never fail there.

What this checks, in a browser, on the page `_display_viewer` writes:

  * both styles draw something from coordinates alone;
  * the SS assignment answers - a CA trace is what predictBackbone exists for;
  * asking for it repeatedly is CHEAP, because the panel asks on every click;
  * the pieces that need data that is absent are absent themselves, rather
    than throwing or drawing nothing.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, types, time

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_minimal.html')

try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, n, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import numpy as np
import py2Dmol

JS = """
<script>
window.addEventListener('load', () => {
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const ink = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
    }
    return n;
  };
  const go = async () => {
    const R = {errors: []};
    window.addEventListener('error', (e) => R.errors.push(String(e.message)));
    try {
      const key = Object.keys(window.py2dmol_viewers)[0];
      const r = window.py2dmol_viewers[key].renderer;
      r.useGPU = false;
      await wait(700);
      const all = [];
      for (let i = 0; i < r.coords.length; i++) all.push(i);

      const look = async (style) => {
        r.setStyle(style);
        await wait(700);
        // ...the assignment, the way the panel asks for it
        // ONE RESIDUE AT A TIME, and a tally: '' from a RANGE means the
        // residues disagree, which is a real answer and not a failure - the
        // start of a helix is coil. What matters here is whether a CA trace
        // gets an assignment at all.
        const t0 = performance.now();
        const first = r.assignedSseFor([Math.floor(r.coords.length * 0.25)]);
        const t1 = performance.now();
        const tally = {};
        for (let i = 0; i < r.coords.length; i++) {
          const one = r.assignedSseFor([i]) || '?';
          tally[one] = (tally[one] || 0) + 1;
        }
        let repeat = 0;
        for (let k = 0; k < 20; k++) r.assignedSseFor(all.slice(0, 5));
        const t2 = performance.now();
        repeat = (t2 - t1) / 20;
        return {style, ink: ink(r.canvas), n: r.coords.length,
                sse: first, tally, coldMs: Math.round((t1 - t0) * 100) / 100,
                warmMs: Math.round(repeat * 1000) / 1000,
                // ...and over the WHOLE structure, which is what a Select all
                // followed by a click costs
                allMs: (() => { const a = performance.now();
                  r.assignedSseFor(all); return Math.round((performance.now() - a) * 100) / 100; })()};
      };
      R.tube = await look('tube');
      R.cartoon = await look('cartoon');

      // WHAT IS ABSENT STAYS ABSENT rather than being invented
      R.absent = {
        sidechainTable: !r.sidechains,
        sidechainOwners: (r.sidechainOwners && r.sidechainOwners())
          ? r.sidechainOwners().size : 0,
        hasSidechainsFor: r.hasSidechainsFor ? r.hasSidechainsFor(all) : null,
        hasElementsFor: r.hasElementsFor ? r.hasElementsFor(all) : null,
        hasBasesFor: r.hasBasesFor ? r.hasBasesFor(all) : null,
        // every position is protein by default, so SSE is offered
        hasSseFor: r.hasSseFor ? r.hasSseFor(all) : null,
        names: (r.positionNames || []).slice(0, 3),
        chains: [...new Set(r.chains || [])],
        types: [...new Set(r.positionTypes || [])],
        nTypes: (r.positionTypes || []).length,
      };
      // ...and the things the panel does, on a structure with none of that
      r.residueSelection = new Set([1, 2, 3]);
      R.after = {
        forced: r.forcedSseFor([1, 2, 3]),
        assigned: r.assignedSseFor([Math.floor(r.coords.length * 0.25)]),
        framing: r.framingPositions ? r.framingPositions(new Set([1, 2])).size : -1,
        within: r.residuesWithin ? r.residuesWithin([1], 8, {}).length : -1,
        pickable: r._pickable ? r._pickable(1) : null,
      };
    } catch (e) { R.errors.push(String((e && e.stack) || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""

# A CA TRACE AND NOTHING ELSE - three turns of an alpha helix followed by a
# strand, so the assignment has something to find.
def trace():
    pts = []
    for i in range(40):
        t = i * 100.0 * np.pi / 180.0
        pts.append([2.3 * np.cos(t), 2.3 * np.sin(t), 1.5 * i])
    for i in range(20):
        pts.append([12.0 + 3.3 * i, 4.0 * (i % 2), 60.0])
    return np.array(pts, dtype=float)


def main():
    v = py2Dmol.view(style='cartoon')
    v.add(trace())                      # ...and nothing else
    body = v._display_viewer(static_data=v.objects)
    open(PROBE, 'w').write('<!doctype html><html><head><meta charset="utf-8">'
                           '</head><body>' + body + JS + '</body></html>')
    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a): pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
            self.send_response(200); self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9715), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=/tmp/py2dmol-min',
                          '--no-first-run', '--window-size=900,900',
                          'http://127.0.0.1:9715/_minimal.html'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + 150
    while not box and time.time() < end:
        time.sleep(0.5)
    p.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree('/tmp/py2dmol-min', ignore_errors=True)
    R = box[0] if box else {'errors': ['no result posted']}

    for style in ('tube', 'cartoon'):
        s = R.get(style) or {}
        print(f"  {style:8s} {s.get('n')} positions, {s.get('ink')} ink,"
              f" SSE {s.get('sse')!r} {s.get('tally')}; {s.get('coldMs')}ms cold,"
              f" {s.get('warmMs')}ms warm, {s.get('allMs')}ms over all of it")
    print(f"  absent: {R.get('absent')}")
    print(f"  panel:  {R.get('after')}")

    bad = []
    for e in R.get('errors', []):
        bad.append('page error: ' + e)
    for style in ('tube', 'cartoon'):
        s = R.get(style) or {}
        if not s.get('ink'):
            bad.append(f'{style} drew nothing from a bare CA trace')
        if s.get('sse') not in ('H', 'E', 'C'):
            bad.append(f"{style}: the assignment answered {s.get('sse')!r} for one"
                       " residue of a CA trace - predictBackbone is what makes"
                       " that possible")
        tally = s.get('tally') or {}
        if tally.get('H', 0) < 5:
            bad.append(f"a 40-residue helix drawn as a CA trace was assigned"
                       f" {tally} - the trace carries the structure and the"
                       " assignment should find it")
        # THE PANEL ASKS ON EVERY CLICK, so a warm ask has to be free
        if s.get('warmMs', 99) > 1.0:
            bad.append(f"{style}: asking again costs {s.get('warmMs')}ms - the"
                       " panel asks on every selection change")
    a = R.get('absent') or {}
    if not a.get('sidechainTable'):
        bad.append('a side-chain table was invented for a structure with no atoms')
    if a.get('hasSidechainsFor') or a.get('hasElementsFor') or a.get('hasBasesFor'):
        bad.append(f'the panel offers rows it has no data for: {a}')
    if not a.get('hasSseFor'):
        bad.append('SSE is withheld from a protein trace')
    after = R.get('after') or {}
    if after.get('forced') != 'none':
        bad.append(f"an untouched trace reads as forced: {after.get('forced')}")
    if after.get('assigned') not in ('H', 'E', 'C'):
        bad.append(f"the panel gets {after.get('assigned')!r} for the assignment")
    if after.get('framing', 0) < 2:
        bad.append(f"framing a selection came back with {after.get('framing')}")
    for m in bad:
        print('FAIL:', m)
    sys.exit(1 if bad else 0)


main()
