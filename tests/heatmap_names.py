"""The panel is `heatmap` now, and the names other people hold still work.

    python3 tests/heatmap_names.py

The panel moved to src/panels/heatmap.js from a file named after the PAE,
and every identifier this tree owns moved with it. What did NOT move is anything another party already
holds - and every one of those fails SILENTLY rather than loudly, which is
what this probe is for:

  * `window.PAE` / `window.PAERenderer` - no modules here, so a global IS the
    interface, and a host page calling one gets "undefined is not a function".
  * `py2dmol_pae_loaded` - dispatched beside the new event.
  * a `paeBoxes:` patch key on setVisibility - an unknown key on a patch
    object is DROPPED WITHOUT A WORD, so a caller's selection silently
    stops happening.
  * `#paeContainer` / `#paeCanvas` - the markup ids. These DID move, to
    `#heatmapContainer` / `#heatmapCanvas`, because an id saying `pae` on a
    box holding a contact map is the most VISIBLE of the old names: it is
    the one a host page author types. The old spellings are still accepted,
    which is the only reason moving them is safe - a renamed id with no
    fallback is a panel that never mounts, on every host page, with nothing
    thrown.

🔴 AND THE SESSION ROUND TRIP, WHICH NOTHING IN THE SUITE TOUCHED.
`saveViewerState` reads `visibilityState.heatmapBoxes.map(...)` UNGUARDED, so
one writer left saying `paeBoxes` is a TypeError that takes the whole save
with it - and six places construct that object. The saved KEY stays
`pae_boxes` because it is the file format and a reader has sessions on disk;
this checks the saved JSON says `pae_boxes` and that loading it back restores
the boxes into the renamed field.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_heatmap_names.html')
FILE = '1UBQ.cif'

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  // The load event has to be caught BEFORE anything else runs: the panel
  // dispatches it while its own script is being evaluated, which is long
  // before this listener could attach. So the page records it from the top.
  const go = async () => {
    const out = { errors: [] };
    try {
      const txt = await (await fetch('/' + '""" + FILE + """')).text();
      await window.processFiles([{name: '""" + FILE + """',
        readAsync: () => Promise.resolve(txt)}], false);
      await until(loaded);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;

      // ---- 1. the globals a host page may already be calling ----
      out.aliases = {
        Heatmap: typeof window.Heatmap,
        HeatmapRenderer: typeof window.HeatmapRenderer,
        PAE: typeof window.PAE,
        PAERenderer: typeof window.PAERenderer,
        sameObject: window.PAE === window.Heatmap,
        sameClass: window.PAERenderer === window.HeatmapRenderer,
        initialize: typeof (window.PAE && window.PAE.initialize),
      };
      out.loadEvents = window.__heatmapEvents || [];

      // ---- 2. the DOM ids host pages provide ----
      out.dom = {
        container: !!document.getElementById('heatmapContainer'),
        canvas: !!document.getElementById('heatmapCanvas'),
        wired: !!r.heatmapContainer,
      };

      // ...AND A PAGE STILL WRITING THE OLD IDS MOUNTS A PANEL. Built here
      // rather than assumed, because "the fallback is in the source" is not
      // the same claim as "a page using it works".
      const legacy = document.createElement('div');
      legacy.id = 'paeContainer';
      legacy.style.cssText = 'position: relative; width: 120px; height: 120px;';
      const lc = document.createElement('canvas');
      lc.id = 'paeCanvas'; lc.width = 120; lc.height = 120;
      legacy.appendChild(lc);
      document.body.appendChild(legacy);
      const host = document.createElement('div');
      host.appendChild(legacy);
      document.body.appendChild(host);
      const stub = { canvas: lc, objectsData: {}, currentObjectName: null,
                     currentFrame: 0, chains: [],
                     visibilityModel: { heatmapBoxes: [], positions: new Set(),
                                        chains: new Set() },
                     getVisibility: () => ({ heatmapBoxes: [] }),
                     setHeatmapRenderer(x) { this.heatmapRenderer = x; } };
      window.Heatmap.initialize(stub, host, { pae: { enabled: true } });
      out.legacyIds = {
        claimed: stub.heatmapContainer === legacy,
        madeRenderer: !!stub.heatmapRenderer,
        boundCanvas: !!(stub.heatmapRenderer
          && stub.heatmapRenderer.canvas === lc),
      };

      // ---- 3. the OLD patch key on setVisibility ----
      // An unknown key is dropped in silence, so this is measured by reading
      // the field back rather than by the call not throwing.
      r.setVisibility({ heatmapBoxes: 'clear' });
      r.setVisibility({ paeBoxes: [{ i_start: 4, i_end: 9,
                                     j_start: 4, j_end: 9 }] });
      out.oldPatchKey = (r.visibilityModel.heatmapBoxes || []).length;
      out.oldPatchBox = (r.visibilityModel.heatmapBoxes || [])[0] || null;
      // ...and the new one, as the control - if BOTH read 0 the check above
      // is measuring a broken setter, not a dropped alias.
      r.setVisibility({ heatmapBoxes: 'clear' });
      r.setVisibility({ heatmapBoxes: [{ i_start: 1, i_end: 3,
                                         j_start: 1, j_end: 3 }] });
      out.newPatchKey = (r.visibilityModel.heatmapBoxes || []).length;

      // ---- 4. THE SESSION ROUND TRIP ----
      // Park a box on the object, then save. saveViewerState downloads a
      // file, so the blob is intercepted rather than the download driven.
      // 🔴 A MAP HAS TO SURVIVE THE ROUND TRIP TOO. Both ends of the
      // session build a frame FIELD BY FIELD, so a field neither names is a
      // field the save drops and the reload never sees - and `maps` was not
      // named by either, so a reloaded session came back with the PAE alone.
      // `pae_n` with it: without the residue count a resampled matrix
      // reloads with residues == cells and a dragged box selects the wrong
      // residues. Given a distinct vmax and caption so the reload cannot
      // pass by falling back to the registry's defaults.
      const objName = r.currentObjectName;
      {
        const o0 = r.objectsData[objName];
        const n0 = o0.frames[0].coords.length;
        const bytes = new Uint8Array(n0 * n0);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
        o0.frames[0].maps = { contact: {
          data: bytes, n: n0 * 2, vmin: 0, vmax: 7,
          colors: ['#ffffff', '#123456'], xlabel: 'Scored', ylabel: 'Aligned',
        } };
        o0.frames[0].pae_n = n0 * 2;
      }
      r.setVisibility({ heatmapBoxes: [{ i_start: 10, i_end: 20,
                                         j_start: 30, j_end: 40 }] });
      if (r.objectsData[objName]) {
        r.objectsData[objName].visibilityState = {
          positions: new Set([5, 6]), chains: new Set(['A']),
          heatmapBoxes: [{ i_start: 10, i_end: 20, j_start: 30, j_end: 40 }],
          visibilityMode: 'explicit',
        };
      }
      let saved = null;
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { saved = blob; return 'blob:stub'; };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      try { window.saveViewerState(); } finally {
        URL.createObjectURL = realCreate;
        HTMLAnchorElement.prototype.click = realClick;
      }
      if (!saved) { out.errors.push('saveViewerState produced no blob'); }
      else {
        const text = await saved.text();
        const state = JSON.parse(text);
        const savedFrame = ((state.objects || []).find(
          (o) => o.name === objName) || {}).frames;
        const sf = savedFrame ? savedFrame[0] : null;
        out.savedMap = (sf && sf.maps && sf.maps.contact)
          ? { n: sf.maps.contact.n, vmax: sf.maps.contact.vmax,
              colors: sf.maps.contact.colors, xlabel: sf.maps.contact.xlabel,
              len: (sf.maps.contact.data || []).length }
          : null;
        out.savedPaeN = sf ? sf.pae_n : null;
        out.savedKeys = Object.keys(
          (state.selections_by_object || {})[objName] || {});
        out.savedBoxes = ((state.selections_by_object || {})[objName]
          || {}).pae_boxes || null;

        // ...and load it back into a viewer whose boxes have been wiped.
        r.setVisibility({ heatmapBoxes: 'clear' });
        if (r.objectsData[objName]) {
          r.objectsData[objName].visibilityState = {
            positions: new Set(), chains: new Set(),
            heatmapBoxes: [], visibilityMode: 'default',
          };
        }
        await window.loadViewerState(state);
        await until(() => !!r.currentObjectName, 6000);
        await settle(4);
        const vs = (r.objectsData[r.currentObjectName] || {}).visibilityState;
        out.restored = vs ? (vs.heatmapBoxes || []).map(
          (b) => [b.i_start, b.i_end, b.j_start, b.j_end]) : null;
        const rf = (r.objectsData[r.currentObjectName] || {}).frames;
        const m = rf && rf[0] && rf[0].maps && rf[0].maps.contact;
        out.reloadedMap = m
          ? { n: m.n, vmax: m.vmax, colors: m.colors, xlabel: m.xlabel }
          : null;
        out.reloadedPaeN = rf && rf[0] ? rf[0].pae_n : null;
        out.restoredHasOldField = vs ? ('paeBoxes' in vs) : null;
      }
    } catch (e) { out.errors.push(String((e && e.stack) || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
  };
  go();
});
</script>
"""
JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)

# 🔴 THE LOAD EVENT FIRES WHILE THE PANEL'S OWN SCRIPT RUNS, so a listener
# attached from a script at the end of <body> is far too late. This one goes
# in the <head>, before any of dev.html's tags.
EARLY = ("<script>window.__heatmapEvents = [];"
         "for (const n of ['py2dmol_heatmap_loaded', 'py2dmol_pae_loaded']) {"
         "  window.addEventListener(n, () => window.__heatmapEvents.push(n));"
         "}</script>")

src = open(os.path.join(ROOT, 'dev.html')).read()
stamp = str(int(time.time() * 1000))
src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
             lambda m: m.group(1) + '?v=' + stamp + m.group(3), src)
assert '<head>' in src, 'dev.html has no <head> to put the early listener in'
src = src.replace('<head>', '<head>' + EARLY, 1)
open(PROBE, 'w').write(src.replace('</body>', JS + '</body>'))

box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
        self.send_response(200); self.send_header('Content-Length', '2')
        self.end_headers(); self.wfile.write(b'ok')


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9798), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=/tmp/py2dmol-hmnames',
                      '--no-first-run', '--window-size=1200,1000',
                      'http://127.0.0.1:9798/_heatmap_names.html'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree('/tmp/py2dmol-hmnames', ignore_errors=True)
R = box[0] if box else {'errors': ['no result posted']}

bad = list(R.get('errors') or [])
a = R.get('aliases') or {}
print(f"  globals: {a}")
print(f"  load events: {R.get('loadEvents')}")
print(f"  dom: {R.get('dom')}")
print(f"  setVisibility paeBoxes -> {R.get('oldPatchKey')} box"
      f" {R.get('oldPatchBox')}; heatmapBoxes -> {R.get('newPatchKey')}")
print(f"  session saved keys {R.get('savedKeys')}, boxes {R.get('savedBoxes')}")
print(f"  restored {R.get('restored')}, still has a paeBoxes field:"
      f" {R.get('restoredHasOldField')}")

for k in ('Heatmap', 'HeatmapRenderer', 'PAE', 'PAERenderer'):
    if a.get(k) not in ('object', 'function'):
        bad.append(f"window.{k} is {a.get(k)}")
if not a.get('sameObject') or not a.get('sameClass'):
    bad.append("the aliases are not the same objects as the new names")
if a.get('initialize') != 'function':
    bad.append("window.PAE.initialize is gone - that is the call a host makes")
ev = R.get('loadEvents') or []
for n in ('py2dmol_heatmap_loaded', 'py2dmol_pae_loaded'):
    if n not in ev:
        bad.append(f"{n} was never dispatched (saw {ev})")
d = R.get('dom') or {}
if not d.get('container') or not d.get('canvas'):
    bad.append(f"the shells' own ids are not the new ones: {d}")
if not d.get('wired'):
    bad.append("the panel did not claim its container")
if R.get('oldPatchKey') != 1:
    bad.append("setVisibility dropped a `paeBoxes:` patch - an unknown key on"
               " a patch object goes without a word, so a caller written"
               " before the rename silently stops selecting")
b = R.get('oldPatchBox') or {}
if b.get('i_start') != 4 or b.get('j_end') != 9:
    bad.append(f"the old patch key stored the wrong box: {b}")
if R.get('newPatchKey') != 1:
    bad.append("the NEW patch key does not work either - the check above is"
               " measuring a broken setter, not a working alias")
sk = R.get('savedKeys') or []
if 'pae_boxes' not in sk:
    bad.append(f"the session file no longer writes pae_boxes: {sk} - that key"
               " is the FILE FORMAT and a reader has sessions on disk")
if R.get('savedBoxes') != [{'i_start': 10, 'i_end': 20,
                            'j_start': 30, 'j_end': 40}]:
    bad.append(f"the session saved {R.get('savedBoxes')}")
if R.get('restored') != [[10, 20, 30, 40]]:
    bad.append(f"loading the session back restored {R.get('restored')},"
               " not the box that was saved")
if R.get('restoredHasOldField'):
    bad.append("the restored state still carries a paeBoxes field beside"
               " heatmapBoxes - two fields for one thing is how they drift")

L = R.get('legacyIds') or {}
print(f"  a page still writing #paeContainer/#paeCanvas: {L}")
if not (L.get('claimed') and L.get('madeRenderer') and L.get('boundCanvas')):
    bad.append(f"the OLD markup ids no longer mount a panel: {L} - that"
               " fallback is the only thing that makes renaming them safe,"
               " and its absence throws nothing anywhere")

sm, rm = R.get('savedMap'), R.get('reloadedMap')
print(f"  map saved    {sm}")
print(f"  map reloaded {rm}, pae_n {R.get('savedPaeN')} -> {R.get('reloadedPaeN')}")
if not sm:
    bad.append("the session saved no `maps` at all - both ends build a frame"
               " field by field and a field neither names is dropped")
elif not rm:
    bad.append(f"the session SAVED a map and the reload dropped it: {sm}")
elif (rm.get('vmax') != 7 or rm.get('xlabel') != 'Scored'
      or rm.get('colors') != ['#ffffff', '#123456'] or rm.get('n') != sm.get('n')):
    bad.append(f"the map came back changed: saved {sm}, reloaded {rm} - the"
               " bounds, the colours and the captions are what a reload"
               " cannot re-derive, so losing them is silent")
if R.get('savedPaeN') != R.get('reloadedPaeN') or not R.get('reloadedPaeN'):
    bad.append(f"pae_n did not survive: {R.get('savedPaeN')} ->"
               f" {R.get('reloadedPaeN')} - without it a resampled matrix"
               " reloads with residues == cells and a dragged box selects"
               " the wrong residues")

for m in bad: print('FAIL:', m)
sys.exit(1 if bad else 0)
