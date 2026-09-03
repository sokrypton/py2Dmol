"""The map panel shows more than one map, and the selection rules do not move.

    python3 tests/heatmap_maps.py

`#paeContainer` used to hold exactly one thing: a predicted aligned error
matrix. But the panel is an N x N heat map over residues with a drag-select on
it, and NOTHING about the drag, the cells/residues crossing, the chain rules,
the dim mask or the selection outlines was ever about what the numbers meant.
Only two things were: how a value becomes a byte, and what colour a byte is.

So a map now declares those two - `perUnit` and a ramp, in MAP_SCALES - and a
frame can carry several, keyed by name, in `frame.maps` beside the `frame.pae`
that every payload still sends. A strip of tabs picks between them, built into
the container at runtime and hidden below two maps.

🔴 WHAT IS NOT ALLOWED TO CHANGE IS THE SELECTION. A box is stored in
RESIDUES, not cells, which is what lets one dragged on the contact map be the
same box on the PAE - and this probe is mostly about that: it drags on the
SECOND map and requires the residues the first one would have given, on a
fixture where the two numbers differ (360 residues resampled to 300 cells).

It runs through `_display_viewer`, which is the notebook's own page, because
the wire is half of the feature: viewer.py encodes `byte = round(value *
per_unit)` and SENDS the per_unit rather than trusting the browser's table to
match. A contact map encoded at 255 and decoded at 8 is a matrix of clamped
values that still draws - a plausible picture of nothing - so the codec is
measured as PIXELS, not as a field that arrived.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, types, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_heatmap_maps.html')

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
  //HELPERS
  const R = () => window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]].renderer;
  const P = () => R().heatmapRenderer;
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Distinct colours on the plot. A codec mismatch does not blank the panel -
  // it clamps every cell into the same bucket - so the tell is how many
  // colours are left, not whether anything was drawn.
  const shades = () => {
    const c = P().canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) {
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return seen.size;
  };
  // A tab says `aria-selected`, the way a latch says aria-pressed - so the
  // marked tab is read from the attribute a screen reader would read, not
  // from a dataset field kept beside it for the test's benefit.
  const tabs = () => [...P().tabStrip.children].map(
    b => b.textContent + (b.getAttribute('aria-selected') === 'true' ? '*' : ''));

  // A REAL DRAG on the plot, in cells. The panel listens for mousedown on the
  // canvas and mousemove/mouseup on the window, and a scripted MouseEvent
  // does reach a listener - it is the browser's CLICK SYNTHESIS that a script
  // cannot drive, and nothing here depends on one.
  const drag = (c0, c1) => {
    const p = P(), c = p.canvas, r = c.getBoundingClientRect();
    const at = (cell) => ({
      x: r.left + (cell + 0.5) * r.width / p.n,
      y: r.top + (cell + 0.5) * r.height / p.n,
    });
    const a = at(c0), b = at(c1);
    const ev = (t, q, el) => el.dispatchEvent(new MouseEvent(t, {
      clientX: q.x, clientY: q.y, bubbles: true, cancelable: true, buttons: 1,
    }));
    ev('mousedown', a, c);
    ev('mousemove', b, window);
    ev('mouseup', b, window);
    const boxes = R().getVisibility().heatmapBoxes || [];
    const last = boxes[boxes.length - 1] || {};
    return { boxes: boxes.length, i: [last.i_start, last.i_end],
             j: [last.j_start, last.j_end],
             // ...and what the pointer was actually given, so a mismatch can
             // be read as arithmetic rather than guessed at.
             px: [Math.round(a.x - r.left), Math.round(b.x - r.left)],
             rect: [Math.round(r.left), Math.round(r.width)],
             canvas: c.width, cellPx: +(r.width / p.n).toFixed(3) };
  };

  const LATE = [];
  const go = async () => {
    const out = { errors: LATE };
    try {
      await frame(); await frame();
      const r = R(), p = P();
      r.setFrame(1); await frame();   // where the extra maps live
      const obj = r.objectsData[r.currentObjectName];
      out.keys = window.Heatmap.mapKeysOf(obj);
      out.residues = p.residues;
      out.cells = p.n;
      out.limits = {};
      out.shades = {};

      // ---- the PAE tab, which is where every viewer opens ----
      out.startKey = p.mapKey;
      out.tabsPae = tabs();
      out.limits.pae = [p.scale.vmin, p.scale.vmax];
      out.shades.pae = shades();
      // ...and a drag on it, as the yardstick for the one below.
      r.setVisibility({ heatmapBoxes: 'clear' });
      out.dragPae = drag(30, 60);

      // ---- the tab node must survive a re-show, or a click is swallowed ----
      const node = p.tabStrip.children[0];
      window.Heatmap.syncToDrawn(r);
      await frame();
      out.sameTabNode = (node === p.tabStrip.children[0]);

      // ---- the contact tab ----
      p.tabStrip.children[1].click();
      await frame();
      out.afterClick = p.mapKey;
      out.tabsContact = tabs();
      out.limits.contact = [p.scale.vmin, p.scale.vmax];
      // ...and the colour it actually drew at full contact, which is where a
      // stated ramp either beat the registry or quietly lost to it.
      // 🔴 READ AS A RATIO, NOT AGAINST A THRESHOLD. The selection wash is
      // 70% white over everything outside the box, so pure red arrives as
      // (255, 179, 179) and any "is it red enough" bound calls that a
      // failure. What separates the two candidates survives the wash: this
      // map asked for white-to-RED, the built-in for white-to-INDIGO, so
      // red-minus-blue is positive for one and negative for the other
      // whatever is laid on top. Clearing the mask first does not work -
      // the wash is also on while the visibility mode is explicit.
      out.contactHot = (() => {
        const c = p.canvas, d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
        return [d[0], d[1], d[2]];
      })();
      out.shades.contact = shades();
      out.cellsContact = p.n;
      out.residuesContact = p.residues;

      // 🔴 THE SAME DRAG, ON THE OTHER MAP. Same cells in, same RESIDUES out.
      r.setVisibility({ heatmapBoxes: 'clear' });
      out.dragContact = drag(30, 60);

      // ...and a box drawn on one map is still drawn on the other, because it
      // was stored in residues. Count the pixels the outline darkened.
      p.tabStrip.children[0].click();
      await frame();
      out.backKey = p.mapKey;
      out.boxesKept = (r.getVisibility().heatmapBoxes || []).length;
      out.shadesBoxed = shades();

      // ---- THE UNREGISTERED MAP IS DRAWN IN GREY ----
      // Not just "legible": falling back to PAE's ramp over a 0-1 matrix
      // gives 150 shades of blue, which passes every count you can write.
      // The generic scale is grey BY CONSTRUCTION, so r === g === b is the
      // one thing that says the fallback is the map's own and not the PAE's.
      // ---- THE MAP WITH NO REGISTRY ENTRY ----
      // Its codec can only have come from the wire, and its label from its
      // own key. A wrong codec here is one flat colour, not a blank panel.
      p.tabStrip.children[2].click();
      await frame();
      out.customKey = p.mapKey;
      out.limits.disorder = [p.scale.vmin, p.scale.vmax];
      out.shades.disorder = shades();
      out.greyness = (() => {
        const c = p.canvas, q = Math.floor(c.width * 0.75);
        const d = c.getContext('2d').getImageData(q, q, 1, 1).data;
        return [d[0], d[1], d[2]];
      })();

      // ---- THE MAP THAT NAMES ITS OWN DOMAIN ----
      p.tabStrip.children[3].click();
      await frame();
      out.rmsdKey = p.mapKey;
      out.limits.rmsd = [p.scale.vmin, p.scale.vmax];
      out.shades.rmsd = shades();
      // 🔴 AND IT RAMPS ACROSS THAT DOMAIN, NOT ACROSS 0-1. `rmsd` is
      // min(25, |i-j|*0.1) at per_unit 10, so its domain is 0-25.5 and two
      // cells far apart in |i-j| are far apart in value. The generic ramp
      // used to clamp the DECODED VALUE at 1, so everything past 1 A drew
      // as the same flat black - and the shade COUNT still passed, because
      // the bottom 4% of the domain ramped normally. Two cells is the check
      // that a count cannot make.
      out.rmsdSpan = (() => {
        const c = p.canvas, w = c.width, ctx = c.getContext('2d');
        const at = (res) => {
          const x = Math.floor((res / 360) * w);
          const d = ctx.getImageData(x, 2, 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        return { near: at(60), far: at(250) };   // value 6 A against 25 A
      })();

      // 🔴 ---- A MAP FOLLOWS THE FRAME, INCLUDING ITS SCALE ----
      // Every key resolves on its own and backwards, so a trajectory can
      // change a map's DATA and its BOUNDS from frame to frame. This also
      // covers the bug that shipped: resolveMapFrame special-cased `pae` to
      // resolveFrame, which reads the legacy `frame.pae` field and knows
      // nothing about `frame.maps` - so a PAE handed over as a map entry
      // resolved to null on EVERY frame and simply never appeared, while
      // any other key worked. Frame 0 here carries only a pae, through
      // `maps`, so if that regresses this leg sees an empty panel.
      out.perFrame = [];
      p.setMap('pae');
      for (const f of [0, 1, 0]) {
        r.setFrame(f);
        await frame();
        out.perFrame.push({
          frame: f, key: p.mapKey,
          keys: Object.keys(p.maps || {}),
          vmax: p.scale.vmax,
          mid: p.bytes ? p.bytes[Math.floor(p.bytes.length / 2)] : null,
        });
      }
      r.setFrame(1); await frame();

      // 🔴 ---- AND A CHOICE OUTLIVES A FRAME THAT CANNOT HONOUR IT ----
      // Step back to frame 0, which has only the PAE, and forward again.
      p.tabStrip.children[1].click();
      await frame();
      r.setFrame(0); await frame();
      out.atFrame0 = { key: p.mapKey, strip: p.tabStrip.style.display };
      r.setFrame(1); await frame();
      out.backAtFrame1 = p.mapKey;

      p.tabStrip.children[0].click();
      await frame();

      // ---- TWO TABS OVER ONE ARRAY, which is the JS host's door ----
      // A page writing frame.maps itself can hand the same Uint8Array to two
      // keys - the same numbers under two scales. The loader's early-out is
      // "same data, same residues", which is TRUE here, so without the cold
      // base image in that question the switch keeps the first map's colours.
      p.setMaps({ pae: { data: p.bytes, n: p.residues },
                  contact: { data: p.bytes, n: p.residues } });
      await frame();
      const sharedA = shades();
      p.setMap('contact');
      await frame();
      out.sharedArray = { pae: sharedA, contact: shades() };

      // ---- ONE MAP STILL GETS ITS TAB, and PAE captions its axes ----
      // The strip used to hide below two maps, which left a lone PAE with
      // nowhere to show its name - the tab names it by its key.
      p.setMaps({ pae: { data: p.bytes, n: p.residues } });
      await frame();
      out.oneMap = {
        strip: p.tabStrip.style.display,
        tabs: [...p.tabStrip.children].map((b) => b.textContent),
        xlabel: p.xLabelEl.textContent,
        ylabel: p.yLabelEl.textContent,
        // ...and the plot is inset below the strip and beside the y caption,
        // while staying SQUARE - the canvas is 100% plot, which is what
        // keeps every cells/residues calculation in this file untouched.
        square: p.canvas.width === p.canvas.height,
        insetTop: parseFloat(p.canvas.style.top) || 0,
        insetLeft: parseFloat(p.canvas.style.left) || 0,
        size: p.canvas.width,
      };
      // A map with no captions reserves no margin for them. `disorder` is
      // the one to ask with: `contact` has captions of its own in the
      // registry, so it would reserve them and this would measure nothing.
      p.setMaps({ disorder: { data: p.bytes, n: p.residues } });
      await frame();
      out.noAxes = {
        xlabel: p.xLabelEl.textContent,
        insetLeft: parseFloat(p.canvas.style.left) || 0,
        size: p.canvas.width,
      };
    } catch (e) { out.errors.push(String(e && e.stack || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
  };
  window.addEventListener('error', (e) => { LATE.push(String(e.message)); });
  go();
});
</script>
"""
JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)

N, SPLIT = 360, 200
ii = np.arange(N)
d = np.abs(ii[:, None] - ii[None, :])
# PAE: 0 on the diagonal out to 30 A, in Angstrom.
pae = np.minimum(30.0, d * 0.2)
# p(contact): a probability, so 0-1 - a different domain AND a different
# codec, which is the whole point of sending the per_unit.
contact = np.exp(-d / 8.0)
# ...and a map this panel has NEVER HEARD OF, which is the case the per_unit
# on the wire exists for: with no registry entry there is nothing to look the
# codec up in, and a 0-1 quantity decoded at PAE's eight bytes per unit is one
# flat colour. Its tab is labelled by its own key.
custom = np.clip(1.0 - d / 90.0, 0.0, 1.0)
# ...and one that names its own domain: a distance in Angstrom, 0-25.5, whose
# codec is neither of the two defaults. Nothing in the browser can guess it.
rmsd = np.minimum(25.0, d * 0.1)

CO = np.stack([ii * 1.5, np.zeros(N), np.zeros(N)], 1)
CH = ['A'] * SPLIT + ['B'] * (N - SPLIT)
v = py2Dmol.view(pae=True)
# 🔴 FRAME 0 CARRIES ONLY THE PAE. The maps are resolved backwards, one at a
# time, so a map that starts on frame 1 does not exist on frame 0 - which is
# the case the reader's chosen tab has to survive.
v.add(CO, name='pred', pae=pae, chains=CH)
v.add(CO, name='pred', chains=CH,
      maps={
        # 🔴 A MAP OVERRIDING THE BUILT-IN SCALE FOR ITS OWN KEY. `contact`
        # has a registry entry - white to indigo - and this says RED instead,
        # which is the whole point of the feature and is measured as a pixel:
        # a stated `colors` that lost to the registry would draw indigo and
        # every "is it drawn" check would still pass.
        'contact': {'data': contact, 'vmin': 0, 'vmax': 1,
                    'colors': ['#ffffff', '#ff0000'],
                    # ...the same captions PAE has by default, so the two
                    # drags below happen on a plot of the same SIZE. At 300
                    # cells in 263px a cell is under a pixel, and comparing
                    # drags across two canvas sizes slips one cell.
                    'xlabel': 'Scored position',
                    'ylabel': 'Aligned position'},
        'disorder': custom,
        'rmsd': {'data': rmsd, 'vmin': 0, 'vmax': 25.5},
        'pae': {'data': pae * 0.5, 'vmin': 0, 'vmax': 30}})

# ---- the wire, before any browser: what viewer.py actually packed ----
frame0 = v.objects[0]['frames'][0]
wire = v.objects[0]['frames'][1]     # where the extra maps were handed in
bad_wire = ("frame 0 was given maps it was not handed"
            if frame0.get('maps') else None)
wire_maps = wire.get('maps') or {}
print(f"payload: frame 0 pae {len(frame0.get('pae') or '')} b64 chars,"
      f" pae_n {frame0.get('pae_n')}; frame 1 maps {sorted(wire_maps)}")
for k, m in sorted(wire_maps.items()):
    print(f"  {k:8s} n={m.get('n')} per_unit={m.get('per_unit')}"
          f" {len(m.get('data') or '')} b64 chars")

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
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9796), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=/tmp/py2dmol-heatmapmaps',
                      '--no-first-run', '--window-size=1100,1000',
                      'http://127.0.0.1:9796/_heatmap_maps.html'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree('/tmp/py2dmol-heatmapmaps', ignore_errors=True)
R = box[0] if box else {'errors': ['no result posted']}

bad = list(R.get('errors') or [])
if bad_wire: bad.append(bad_wire)
print(f"  maps on the object {R.get('keys')}, {R.get('residues')} residues"
      f" in {R.get('cells')} cells")
print(f"  opens on {R.get('startKey')!r} {R.get('tabsPae')},"
      f" limits {R.get('limits')}, shades {R.get('shades')}")
print(f"  click -> {R.get('afterClick')!r} {R.get('tabsContact')},"
      f" {R.get('residuesContact')} residues in {R.get('cellsContact')} cells")
print(f"  drag cells 30-60:  on PAE {R.get('dragPae')}")
print(f"                     on contact {R.get('dragContact')}")
print(f"  two tabs over one array: {R.get('sharedArray')}")
print(f"  same tab node after a re-show {R.get('sameTabNode')},"
      f" box kept across tabs {R.get('boxesKept')}")
print(f"  one map: {R.get('oneMap')}")
print(f"  no captions: {R.get('noAxes')}")

# --- the wire ---
if sorted(wire_maps) != ['contact', 'disorder', 'pae', 'rmsd']:
    bad.append(f"viewer.py packed {sorted(wire_maps)}")
else:
    for k, lo, hi in (('contact', 0.0, 1.0), ('disorder', 0.0, 1.0),
                      ('rmsd', 0.0, 25.5), ('pae', 0.0, 30.0)):
        c = wire_maps[k]
        if (c.get('vmin'), c.get('vmax')) != (lo, hi):
            bad.append(f"{k} went out over {c.get('vmin')}..{c.get('vmax')},"
                       f" not {lo}..{hi}")
        if c.get('n') != N:
            bad.append(f"{k} claims {c.get('n')} residues, not {N}")
    if wire_maps['contact'].get('colors') != ['#ffffff', '#ff0000']:
        bad.append(f"the stated colours did not travel:"
                   f" {wire_maps['contact'].get('colors')}")
    if wire_maps['disorder'].get('colors'):
        bad.append("a map that said nothing about itself was sent styling"
                   " anyway - the built-in scale is what silence means")
if frame0.get('pae_n') != N:
    bad.append(f"pae_n is {frame0.get('pae_n')}, not {N}")

# --- the panel ---
if R.get('keys') != ['pae', 'contact', 'disorder', 'rmsd']:
    bad.append(f"the object's maps read as {R.get('keys')}")
if R.get('startKey') != 'pae':
    bad.append(f"the panel opened on {R.get('startKey')!r}, not the PAE")
if R.get('tabsPae') != ['PAE*', 'Contact', 'disorder', 'rmsd']:
    bad.append(f"the strip reads {R.get('tabsPae')}")
if R.get('afterClick') != 'contact' or R.get('tabsContact') != ['PAE', 'Contact*', 'disorder', 'rmsd']:
    bad.append(f"clicking Contact gave {R.get('afterClick')!r} {R.get('tabsContact')}")
if R.get('customKey') != 'disorder':
    bad.append(f"the unregistered map's tab gave {R.get('customKey')!r}")
g = R.get('greyness') or [0, 0, 0]
if not (g[0] == g[1] == g[2]) or g[0] in (0, 255):
    bad.append(f"the unregistered map drew {g} - it takes the generic grey"
               " scale, not PAE's, whose blues are legible and wrong")
if R.get('rmsdKey') != 'rmsd':
    bad.append(f"the self-describing map's tab gave {R.get('rmsdKey')!r}")
sp = R.get('rmsdSpan') or {}
if sp.get('near') == sp.get('far'):
    bad.append(f"6 A and 25 A drew the same colour {sp} on a map whose domain"
               " is 0-25.5 - a ramp with no units must span what the map"
               " DECLARED, and clamping the value at 1 leaves 96% of it flat")
pf = R.get('perFrame') or []
print(f"  frame by frame: {pf}")
if len(pf) != 3 or any(not x.get('keys') for x in pf):
    bad.append(f"a map did not follow the frame: {pf} - an empty `keys` is a"
               " map that resolved to nothing, which is what a PAE delivered"
               " through `maps` used to do on every frame")
elif [x['vmax'] for x in pf] != [255 / 8, 30, 255 / 8]:
    bad.append(f"the SCALE did not follow the frame: {pf} - frame 0's pae"
               " comes through the legacy field and takes the built-in"
               " 0-31.875, frame 1's states 0-30 through `maps`, and"
               " stepping back must restore the first")
elif pf[0]['mid'] == pf[1]['mid']:
    bad.append(f"the DATA did not follow the frame: {pf}")

f0 = R.get('atFrame0') or {}
if f0.get('key') != 'pae' or f0.get('strip') == 'none':
    bad.append(f"frame 0 has only the PAE and showed {f0} - one map still"
               " gets its tab")
if R.get('backAtFrame1') != 'contact':
    bad.append(f"stepping over a frame without the chosen map left the reader"
               f" on {R.get('backAtFrame1')!r} - the tab they clicked has to"
               " outlive a frame that cannot honour it")
if R.get('backKey') != 'pae':
    bad.append(f"clicking back gave {R.get('backKey')!r}")
if not R.get('sameTabNode'):
    bad.append("a re-show REBUILT the tab buttons - a click landing on one"
               " while the frame advances would be swallowed, which is the"
               " play button's bug in a smaller control")
om = R.get('oneMap') or {}
if om.get('strip') == 'none' or om.get('tabs') != ['PAE']:
    bad.append(f"one map got no tab: {om} - a lone PAE has nowhere else to"
               " show its name")
if om.get('xlabel') != 'Scored position' or om.get('ylabel') != 'Aligned position':
    bad.append(f"the PAE axes are captioned {om.get('xlabel')!r} /"
               f" {om.get('ylabel')!r}")
if not om.get('square'):
    bad.append("the plot is no longer square - `size` is used for both axes")
# 15 is HM_AXIS, and it is the inset on ALL FOUR sides now - the tab strip
# hangs outside the box rather than taking a band inside it, so the top is a
# caption's width like the others rather than the strip's height. The canvas
# is CENTRED in what is left, so a few pixels of inset can be the centring;
# the margin is the part that is at least a caption wide.
if not (om.get('insetTop', 0) >= 15 and om.get('insetLeft', 0) >= 15):
    bad.append(f"the canvas was not inset for the chrome: {om} - the labels"
               " would be drawn over the plot")
na = R.get('noAxes') or {}
if na.get('xlabel'):
    bad.append(f"a map with no captions still shows one: {na}")
if na.get('insetLeft', 0) >= 15:
    bad.append(f"a map with no captions still reserves their margin: {na}")
if not (na.get('size', 0) > om.get('size', 0)):
    bad.append(f"dropping the captions did not give the plot its space back:"
               f" {na.get('size')} against {om.get('size')}")

# --- the codec, as pixels ---
pu = R.get('limits') or {}
# ...read on FRAME 1, where the pae comes through `maps` and states 0-30.
# The legacy field's own 0-31.875 is checked by the frame-by-frame walk
# below, which steps back to frame 0 and requires it to return.
want_limits = {'pae': [0, 30], 'contact': [0, 1],
               'disorder': [0, 1], 'rmsd': [0, 25.5]}
if pu != want_limits:
    bad.append(f"the panel decoded over {pu}, not {want_limits} - vmin/vmax"
               " travel with the data precisely so they cannot be looked up"
               " wrong")
hot = R.get('contactHot') or [0, 0, 0]
if not (hot[0] - hot[2] > 40 and hot[1] == hot[2]):
    bad.append(f"full contact drew {hot}: red minus blue is"
               f" {hot[0] - hot[2]}, and this map asked for white-to-RED."
               " The built-in scale for `contact` is white-to-INDIGO, which"
               " comes out negative here - so a stated `colors` that lost to"
               " the registry looks exactly like this")
sh = R.get('shades') or {}
# A 0-1 matrix decoded at 8 bytes per unit clamps every cell past 1/8 into the
# ramp's top, so the plot survives as a handful of colours. Both real maps are
# smooth gradients over 360 residues and have dozens.
for k in ('pae', 'contact', 'disorder', 'rmsd'):
    if (sh.get(k) or 0) < 20:
        bad.append(f"the {k} plot has {sh.get(k)} distinct colours, which is"
                   " what a matrix decoded with the wrong codec looks like")

# --- THE SELECTION RULE, which is the thing that may not move ---
dp, dc = R.get('dragPae') or {}, R.get('dragContact') or {}
if dp.get('boxes') != 1 or dc.get('boxes') != 1:
    bad.append(f"a drag did not store one box: pae {dp}, contact {dc}")
elif dp.get('i') != dc.get('i') or dp.get('j') != dc.get('j'):
    bad.append(f"the same drag selected {dp.get('i')}/{dp.get('j')} on the PAE"
               f" and {dc.get('i')}/{dc.get('j')} on the contact map - a box is"
               " stored in RESIDUES and must not depend on which map is up")
elif abs(dp.get('i')[0] - 36) > 2 or abs(dp.get('i')[1] - 72) > 2:
    # ...AND THE ABSOLUTE ANSWER, not just agreement between the two maps.
    # They run the same code, so a cells/residues slip moves BOTH and the
    # comparison above still passes. Cells 30-60 of 300, over 360 residues,
    # are residues 36..72 - cellsToResidues, the identity until a matrix is
    # resampled, which is exactly what a notebook does.
    #
    # 🔴 WITHIN TWO RESIDUES, AND THE TOLERANCE IS NOT SLOP. `clientX` is an
    # INTEGER per spec, so the browser truncates the float pixel this drag
    # asks for - and the plot is 263px for 300 cells, so a cell is 0.877px
    # and that half-pixel is a cell and a half. Measured: the drag asks for
    # 26.74px and the panel receives 26. What the check exists to catch is a
    # crossing that stopped converting at all, which reports the CELLS (30
    # and 60) - six and twelve residues away, well outside this.
    bad.append(f"a drag over cells 30-60 of {R.get('cells')} selected residues"
               f" {dp.get('i')} of {R.get('residues')}, not about [36, 72]")
sa = R.get('sharedArray') or {}
if not sa.get('pae') or sa.get('pae') == sa.get('contact'):
    bad.append(f"two tabs over ONE array drew the same picture {sa} - the"
               " scales differ, so the switch has to reload even though the"
               " data is identical")
if R.get('boxesKept') != 1:
    bad.append(f"switching tabs lost the selection: {R.get('boxesKept')} boxes")

for m in bad: print('FAIL:', m)
sys.exit(1 if bad else 0)
