"""N slots, every view, and nothing paid twice.

    python3 tests/slots.py

src/parts/slots.js turns the viewer's boxes into numbered places: slot 1 where
the structure was, slot 2 where the heatmap was, every one of them carrying the
same tabs - Structure, each map, Scatter. A view lives in one slot; picking it
in another swaps them. This probe drives it on dev.html and asks for the things
that are the design rather than the look:

  1. AN OBJECT WITH NO COORDINATES PUTS ITS MAP IN SLOT 1. That is the
     case the feature was asked for - a fold whose trunk has a contact map and
     no structure yet - and it is a DEFAULT, not a rule: the structure takes
     slot 1 back the moment it has frames.
  2. THE SLOTS MIRROR. Picking the view another slot shows swaps them.
  3. 🔴 ONLY WHAT IS ON SCREEN HOLDS A PICTURE. Counted as panels holding a
     decoded matrix against maps on screen - a parked panel keeping its n^2
     bytes and 4n^2 image is exactly the memory this was not allowed to add.
  4. 🔴 A PARKED STRUCTURE DRAWS NOTHING, and keeps its canvas. The render
     loop is left spinning (auto-rotate) while the structure is parked and the
     draws are counted; and the canvas must come back at the size it left at,
     because the viewport used to clamp a hidden box to 1x1 and the return then
     rebuilt the mesh.
  5. A CHOICE OUTLIVES A STATE THAT CANNOT HONOUR IT. PAE picked for slot 1,
     then a blank object with only a contact map, then the PAE back: the
     reader's pick returns with it.
  6. 🔴 EVERY SLOT IS A BOX YOU CAN SIZE. A knob and a resize on each, which
     the big/small version had on the first one alone - the name was deciding
     a capability. Full screen is slot 1's alone, deliberately: it takes over
     the page, so it is one act with one door.
  7. THE LIST IS THE API, and `{big, small}` still arrives: it is in every
     notebook and every session file written before the slots were numbered,
     and LocalFold opens a fold with it.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_slots.html')
FILE = '1UBQ.cif'

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  const go = async () => {
    const out = { errors: [] };
    try {
      const txt = await (await fetch('/""" + FILE + """')).text();
      await window.processFiles([{name: '""" + FILE + """',
        readAsync: () => Promise.resolve(txt)}], false);
      await until(loaded);
      await settle(4);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      const S = r._slots;
      out.bound = !!S;
      if (!S) throw new Error('no slots on the website');

      const n = 76;
      const mat = (f) => { const u = new Uint8Array(n * n);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) u[i * n + j] = f(i, j);
        return u; };
      const pae = mat((i, j) => Math.min(255, Math.abs(i - j) * 6));
      const con = mat((i, j) => Math.abs(i - j) < 4 ? 255 : 0);
      const holding = () => (r._heatmapPool || []).filter((e) => !!e.hm.bytes).length;
      const onScreen = () => S.shown()
        .filter((v) => v && v.startsWith('map:')).length;
      // ...and how many views are actually IN each slot's body. The names
      // above say what the slot MEANS to show; a swap that forgot to park the
      // view it replaced leaves two boxes stacked in one slot, and every name
      // still reads right.
      const inBody = (sl) => sl.body.querySelectorAll(':scope > .py2dmol-slot-view').length;
      const snap = () => ({ big: S.shown()[0], small: S.shown()[1],
        inBig: inBody(S.layout.slots[0]), inSmall: inBody(S.layout.slots[1]),
        holding: holding(), onScreen: onScreen(),
        pool: (r._heatmapPool || []).length });

      // ---- THE DRAG AND ITS KNOB BELONG TO EVERY SLOT ----
      // The view's own .resize-handle is hidden wherever it lands and each
      // body carries resize + one knob. The regression this catches SHIPPED -
      // a view is 100% !important in a slot, so the notebook and the embed,
      // whose boxes carried resize: both themselves, could not be dragged at
      // all while still showing a corner triangle that said they could. And
      // the SECOND slot had neither, because the drag had been given to
      // whichever slot was called big - a reader could not make the map
      // bigger, which is the whole reason the slots are numbers now.
      const visible = (root, sel) => [...root.querySelectorAll(sel)]
        .filter((h) => getComputedStyle(h).display !== 'none').length;
      const knobs = () => ({
        knobs: S.layout.slots.map((sl) => visible(sl.body, '.py2dmol-slot-knob')),
        viewHandles: S.layout.slots
          .reduce((a, sl) => a + visible(sl.body, '.resize-handle'), 0),
        resize: S.layout.slots.map((sl) => getComputedStyle(sl.body).resize),
        fs: S.layout.slots
          .map((sl) => sl.body.querySelectorAll(':scope > .py2dmol-fs-btn').length),
      });

      // ---- a structure and nothing else: one slot, no tabs ----
      out.alone = Object.assign(snap(), {
        smallHidden: S.layout.slots[1].slot.hidden,
        bigTabsHidden: S.layout.slots[0].tabs.hidden,
        nSlots: S.count(),
        // ...and the classes, both spellings. A host stylesheet written
        // against the first version says `.py2dmol-slot--big`, and four
        // probes in this tree did until the numbers arrived.
        classes: S.layout.slots.map((sl) => [...sl.slot.classList]
          .filter((c) => c.startsWith('py2dmol-slot--'))),
        canvas: r.canvas.width,
      });

      // ---- two maps arrive ----
      const obj = r.objectsData[r.currentObjectName];
      obj.frames[0].maps = { pae: { data: pae, n }, contact: { data: con, n } };
      window.Heatmap.updateFrame(r, obj, 0);
      await settle(3);
      out.maps = Object.assign(snap(), {
        tabs: [...S.layout.slots[1].tabs.children].map((b) => b.dataset.view) });
      out.knobs = knobs();

      // ---- 🔴 AND AN OBJECT BETWEEN ITS FRAMES CHANGES NOTHING ----
      // Loading a structure over one that is already there empties the object
      // and refills it, and the refill is not in the same task - so a frame
      // lands where the renderer still holds the drawn COORDINATES and the
      // object has no frames and the panel no maps. The slot then saw one
      // view, hid the tab row, and put it back a frame later with every tab
      // in it. Reported as the tabs disappearing and reappearing at the end
      // of a fold, with the layout jumping under them.
      {
        const before = [...S.layout.slots[0].tabs.children].map((b) => b.dataset.view);
        const keptFrames = obj.frames;
        const keptMaps = r.heatmapRenderer.maps;
        obj.frames = [];                       // ...emptied, as the loader does
        r.heatmapRenderer.setMaps({});
        await settle(4);
        out.between = {
          before,
          hidden: S.layout.slots[0].tabs.hidden,
          tabs: [...S.layout.slots[0].tabs.children].map((b) => b.dataset.view),
          coords: r.coords.length, frames: obj.frames.length,
        };
        obj.frames = keptFrames;               // ...and refilled
        if (keptMaps) r.heatmapRenderer.setMaps(keptMaps);
        window.Heatmap.updateFrame(r, obj, 0);
        await settle(4);
        out.after = {
          hidden: S.layout.slots[0].tabs.hidden,
          tabs: [...S.layout.slots[0].tabs.children].map((b) => b.dataset.view),
        };
      }
      // ...and a drag on the big body reaches whatever is in it.
      const wasCanvas = r.canvas.width;
      S.layout.slots[0].body.style.width = '520px';
      S.layout.slots[0].body.style.height = '360px';
      await settle(8);
      out.dragged = [wasCanvas, r.canvas.width, r.canvas.height];
      S.layout.slots[0].body.style.width = ''; S.layout.slots[0].body.style.height = '';
      await settle(4);

      // ---- the mirror ----
      S.choose(1, 'map:pae'); await settle(3);
      out.swapped = Object.assign(snap(), { canvas: r.canvas.width });
      // ...the width it had in the SMALL slot, which is the one it is parked at
      const cw = r.canvas.width;
      S.choose(2, 'map:contact'); await settle(3);
      out.twoMaps = snap();

      // ---- the structure is parked now: spin it, count the draws ----
      let draws = 0;
      const orig = r.render.bind(r);
      r.render = (...a) => { draws++; return orig(...a); };
      r.autoRotate = true;
      await settle(12);
      out.parkedDraws = draws;
      out.parkedCanvas = [cw, r.canvas.width];
      S.choose(1, 'molecular'); await settle(6);
      out.backDraws = draws;
      r.autoRotate = false;
      r.render = orig;
      out.back = Object.assign(snap(), { canvas: r.canvas.width });

      // ---- A BLINK IS NOT A DEPARTURE ----
      // Every ingestion path empties an object before the new frames land, so
      // for a frame or two the object it is drawing has no coordinates. With a
      // renderer-level map on screen - which is how a fold keeps a live
      // contact map - slot 1 used to hand itself to that map and take it
      // back: reported as the contact map briefly replacing the structure when
      // the last frame arrives. Sampled every animation frame, it read
      // structure -> contact -> structure.
      {
        const obj = r.objectsData[r.currentObjectName];
        const kept = obj.frames.slice();
        const seen = [];
        let watching = true;
        const watch = () => {
          if (!watching) return;
          const v = String(S.shown()[0]);
          if (!seen.length || seen[seen.length - 1] !== v) seen.push(v);
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
        await settle(2);
        obj.frames.length = 0;
        r.render('emptied'); await settle(3);
        const during = String(S.shown()[0]);
        for (const f of kept) obj.frames.push(f);
        r.render('back'); await settle(3);
        watching = false;
        out.blink = { during, after: String(S.shown()[0]), trail: seen };
      }

      // ---- no coordinates: a blank object with a contact map alone ----
      S.choose(1, 'map:pae'); await settle(3);
      r.addObject('blank');
      if (r.currentObjectName !== 'blank') r._switchToObject('blank');
      r.heatmapRenderer.setMaps({ contact: { data: con, n } });
      window.Heatmap.updateVisibility(r);
      await settle(3);
      out.blank = snap();
      // ---- a frame whose coords are EMPTY is also no structure ----
      // The notebook idiom: a map has to ride on a frame, so "a contact map
      // and no structure yet" is a frame with an empty coords array. Counting
      // frames read that as a structure, and an empty Structure tab sat
      // beside the map for the whole trunk.
      r.addObject('trunkish');
      if (r.currentObjectName !== 'trunkish') r._switchToObject('trunkish');
      // The map rides ON the frame, which is what Python sends - with frames
      // present the panel resolves maps per frame, so a setMaps() here would
      // be cleared and the leg would test nothing.
      r.objectsData['trunkish'].frames.push(
          { coords: [], maps: { contact: { data: con, n } } });
      r.setFrame(0);
      window.Heatmap.updateVisibility(r);
      await settle(3);
      out.emptyFrame = snap();
      // ...and one WITH coordinates is, on the same object.
      r.objectsData['trunkish'].frames.push(
          { coords: [[0, 0, 0], [1, 1, 1]], maps: { contact: { data: con, n } } });
      r.setFrame(1); await settle(3);
      out.realFrame = snap();
      r._switchToObject('1UBQ'); await settle(3);
      // ...and the reader's PAE pick comes back with the PAE.
      r.heatmapRenderer.setMaps({ pae: { data: pae, n }, contact: { data: con, n } });
      await settle(3);
      out.pickBack = snap();
      // ---- the API names things the way Python and the embed do ----
      // ...on the object that HAS a structure: 'blank' has none to put there,
      // and slot 1 then correctly falls back to a map.
      r._switchToObject('1UBQ'); r.setFrame(0); await settle(3);
      r.setSlots(['structure', 'contact']); await settle(3);
      out.api = { list: r.getSlots(), big: r.getSlots().big,
                  small: r.getSlots().small };
      // ...and the first version's spelling still lands where it did. LocalFold
      // opens a fold with it and every session file holds it, so this is the
      // compat surface and not politeness.
      r.setSlots({ big: 'contact', small: 'structure' }); await settle(3);
      out.legacy = r.getSlots();
      // ...and a SHORT list names the slots it reaches and no others, which is
      // the whole reason the count is a separate field: naming the first box
      // is not also an answer about how many boxes there are, or about what
      // is in the second one.
      // 🔴 AND THE SECOND SLOT IS ASKED FOR THE ONE THING THE DEFAULT WOULD
      // NOT PICK. An unnamed slot takes a map before the structure, so a leg
      // that leaves a MAP there passes whether the want survived or was
      // cleared - measured: clearing every want on a short list read as green.
      r.setSlots(['pae', 'structure']); await settle(3);
      r.setSlots(['contact']); await settle(3);
      out.shortList = snap();
      // ---- one slot on purpose: a COUNT, not a view called 'none' ----
      // Last, because a standing choice outlives the leg that made it and
      // this one would otherwise overwrite the reader's PAE pick above.
      S.setSlots({ views: ['structure'], count: 1 }); await settle(3);
      out.oneSlot = { ...snap(),
        smallHidden: S.layout.slots[1].slot.hidden };  // as the 'alone' leg reads it
      // ...and small: 'none' is the old way of saying the same thing.
      S.setSlots({ big: 'structure', small: 'none' }); await settle(3);
      out.oneSlotLegacy = { ...snap(),
        smallHidden: S.layout.slots[1].slot.hidden };
      S.setSlots({ views: [], count: 2 }); await settle(3);
      out.twoAgain = snap();
    } catch (e) { out.errors.push(String(e && e.stack || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
  };
  go();
});
</script>
"""
JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)

def serve_and_read(page_html, port, profile):
    """Serve the repo with one extra page and read back what it posts."""
    open(PROBE, 'w').write(page_html)
    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a): pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
            self.send_response(200); self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    proc = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=' + profile,
                             '--no-first-run', '--window-size=1200,1000',
                             'http://127.0.0.1:%d/_slots.html' % port],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end:
        time.sleep(0.5)
    proc.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree(profile, ignore_errors=True)
    return box[0] if box else {'errors': ['no result posted']}


stamp = str(int(time.time()))
src = open(os.path.join(ROOT, 'dev.html')).read()
src = re.sub(r'(src="(?:\./)?src/[^"]+?\.js)(\?[^"]*)?(")',
             lambda m: m.group(1) + '?v=' + stamp + m.group(3), src)
R = serve_and_read(src.replace('</body>', JS + '</body>'), 9794, '/tmp/py2dmol-slots')

for k in ('alone', 'maps', 'swapped', 'twoMaps', 'back', 'blank', 'pickBack'):
    print(f"  {k:9s} {R.get(k)}")
print(f"  draws while parked {R.get('parkedDraws')}, after coming back"
      f" {R.get('backDraws')}; canvas {R.get('parkedCanvas')}")

bad = list(R.get('errors') or [])
al = R.get('alone') or {}
if al.get('big') != 'molecular' or not al.get('smallHidden') or not al.get('bigTabsHidden'):
    bad.append(f"a structure with nothing else changed the page: {al}")
if al.get('nSlots') != 2:
    bad.append(f"the website came up with {al.get('nSlots')} slots, not 2")
if al.get('classes') != [['py2dmol-slot--1', 'py2dmol-slot--big'],
                         ['py2dmol-slot--2', 'py2dmol-slot--small']]:
    bad.append(f"the slots wear {al.get('classes')} - the number is the name"
               " and the old one is the alias a host stylesheet may hold")
m = R.get('maps') or {}
if m.get('big') != 'molecular' or m.get('small') != 'map:pae':
    bad.append(f"two maps did not open as structure in slot 1, PAE in slot 2: {m}")
bt = R.get('between') or {}
at = R.get('after') or {}
print(f"  mid-rebuild: tabs {bt.get('tabs')} hidden={bt.get('hidden')}"
      f" (coords {bt.get('coords')}, frames {bt.get('frames')});"
      f" after: {at.get('tabs')} hidden={at.get('hidden')}")
if bt.get('frames') != 0 or not bt.get('coords'):
    bad.append(f"the mid-rebuild leg did not reach that state: {bt}")
elif bt.get('hidden') or bt.get('tabs') != bt.get('before'):
    bad.append(f"the tab row changed while the object was between its frames:"
               f" {bt.get('before')} -> {bt.get('tabs')} (hidden"
               f" {bt.get('hidden')}). An object with no frames and a drawn"
               " structure is mid-load and says nothing about which views"
               " there are")
if at.get('hidden') or (at.get('tabs') or []) != (bt.get('before') or []):
    bad.append(f"the tabs did not come back after the rebuild: {at}")

if m.get('tabs') != ['molecular', 'map:pae', 'map:contact']:
    bad.append(f"slot 2's tabs are {m.get('tabs')}")
sw = R.get('swapped') or {}
if sw.get('big') != 'map:pae' or sw.get('small') != 'molecular':
    bad.append(f"picking slot 2's view for slot 1 did not swap the two: {sw}")
tm = R.get('twoMaps') or {}
if tm.get('big') != 'map:pae' or tm.get('small') != 'map:contact':
    bad.append(f"two maps did not go one to each slot: {tm}")
for k in ('alone', 'maps', 'swapped', 'twoMaps', 'back', 'blank', 'pickBack'):
    s = R.get(k) or {}
    if s.get('inBig') != 1 or s.get('inSmall') != (1 if s.get('small') else 0):
        bad.append(f"{k}: {s.get('inBig')} views in slot 1 and"
                   f" {s.get('inSmall')} in slot 2 - a view that was"
                   " replaced is still standing in the slot")
    if s.get('holding') != s.get('onScreen'):
        bad.append(f"{k}: {s.get('holding')} panels hold a decoded matrix for"
                   f" {s.get('onScreen')} maps on screen - a hidden map is"
                   " paying n^2 bytes and a 4n^2 image for nothing")
if (R.get('parkedDraws') or 0) > 0:
    bad.append(f"the structure drew {R.get('parkedDraws')} times while parked"
               " and spinning - the loop is meant to skip a canvas it cannot see")
if not ((R.get('backDraws') or 0) > (R.get('parkedDraws') or 0)):
    bad.append("the structure did not draw when it came back out of the park")
pc = R.get('parkedCanvas') or [0, 0]
if pc[0] != pc[1] or pc[1] <= 1:
    bad.append(f"the canvas went {pc[0]} -> {pc[1]} while parked - a hidden box"
               " is not a small one, and the trip back rebuilds the mesh")
bk = R.get('back') or {}
if (sw.get('canvas') or 0) >= (al.get('canvas') or 0):
    bad.append(f"the structure did not follow slot 2: {sw.get('canvas')}"
               f" against {al.get('canvas')} in slot 1")
if bk.get('big') != 'molecular' or bk.get('canvas') != al.get('canvas'):
    bad.append(f"the structure came back wrong: {bk}")
bk2 = R.get('blink') or {}
print(f"  blink     while the object is empty: big={bk2.get('during')},"
      f" after={bk2.get('after')}, trail={bk2.get('trail')}")
if bk2.get('during') != 'molecular' and bk2.get('during') != 'structure':
    bad.append(f"slot 1 went to {bk2.get('during')} while the object was"
               " empty for a frame - an ingestion empties an object before the"
               " new frames land, and the slot must not hand itself to a map"
               " and back. The empty-slot default is for an object that never"
               " had coordinates, not for one mid-update.")
if bk2.get('after') != bk2.get('during'):
    bad.append(f"slot 1 moved from {bk2.get('during')} to"
               f" {bk2.get('after')} when the frames came back - it should not"
               " have moved at all")

bl = R.get('blank') or {}
if bl.get('big') != 'map:contact':
    bad.append(f"an object with no coordinates left its map in slot 2: {bl}"
               " - that is the case this was built for")
ef = (R.get('emptyFrame') or {}).get('big')
rf = (R.get('realFrame') or {}).get('big')
print(f"  coords    empty frame -> big={ef}, real frame -> big={rf}")
os1 = R.get('oneSlot') or {}
os2 = R.get('twoAgain') or {}
print(f"  one slot  {os1.get('big')}/{os1.get('small')} hidden={os1.get('smallHidden')}"
      f"   ...and null gives back {os2.get('big')}/{os2.get('small')}")
if os1.get('small') is not None or not os1.get('smallHidden'):
    bad.append(f"count: 1 still used the second slot: {os1} - the count is how"
               " many boxes there are, and a view name is what is in one")
osl = R.get('oneSlotLegacy') or {}
if osl.get('small') is not None or not osl.get('smallHidden'):
    bad.append(f"small: 'none' did not truncate to one slot: {osl} - it is the"
               " first version's spelling of count: 1 and is in saved state")
if os2.get('small') is None:
    bad.append(f"count: 2 did not hand the slot back to the automatic"
               f" choice: {os2}")
if ef != 'map:contact':
    bad.append(f"a frame with an EMPTY coords array counted as a structure:"
               f" big={ef}, expected map:contact - hasCoords is counting frames"
               " rather than coordinates, so the map never takes slot 1")
if rf != 'molecular':
    bad.append(f"a frame WITH coordinates did not take slot 1: big={rf}"
               " - the empty-coords rule has gone too far")
pb = R.get('pickBack') or {}
if pb.get('big') != 'map:pae':
    bad.append(f"the PAE the reader put in slot 1 did not come back with"
               f" the PAE: {pb}")

kn = R.get('knobs') or {}
print(f"  knobs     {kn}")
if kn.get('knobs') != [1, 1] or kn.get('viewHandles') != 0:
    bad.append(f"the resize knobs are {kn} - ONE PER SLOT, and a view's own"
               " handle hidden wherever it lands. A knob on the first slot"
               " alone is the name deciding a capability, which is what the"
               " numbering is for")
if kn.get('resize') != ['both', 'both']:
    bad.append(f"the slot bodies resize {kn.get('resize')} - every slot is a"
               " box you can size, and a view in a slot is 100% !important, so"
               " a box that still states its own resize cannot be dragged")
# 🔴 FULL SCREEN IS SLOT 1's ALONE, WHERE THE DRAG IS EVERY SLOT'S. Asked
# for that way: sizing a box is a thing you do to that box, and going full
# screen takes over the page, so a button per slot is the same act offered
# twice. It is on the SLOT rather than on the canvas box, which is what stops
# it leaving with the structure when the structure is put somewhere else.
if kn.get('fs') != [1, 0]:
    bad.append(f"the full-screen buttons are {kn.get('fs')} - slot 1 has the"
               " one, and no other slot has any")
dg = R.get('dragged') or [0, 0, 0]
if not (dg[1] != dg[0] and dg[1] > 400 and dg[2] > 200):
    bad.append(f"dragging slot 1 did not reach the canvas: {dg}")

api = R.get('api') or {}
print(f"  api       {api}   legacy {R.get('legacy')}   short {R.get('shortList')}")
if (api.get('list') or [])[:2] != ['structure', 'contact']:
    bad.append(f"setSlots(['structure', 'contact']) reads back {api.get('list')}")
if api.get('big') != 'structure' or api.get('small') != 'contact':
    bad.append(f"getSlots() lost its .big/.small: {api} - they name slots 1 and"
               " 2 and are what everything written before the numbers reads")
lg = R.get('legacy') or []
if lg[:2] != ['contact', 'structure']:
    bad.append(f"setSlots({{big, small}}) no longer places anything: {lg}")
sh = R.get('shortList') or {}
if sh.get('big') != 'map:contact' or sh.get('small') != 'molecular':
    bad.append(f"a one-item list changed the second slot too: {sh} - it names"
               " the slots it reaches and says nothing about the rest")

# ---- THE NOTEBOOK: set_slots() before show() travels in the config ----
# A standing choice made in Python, on the page _display_viewer writes, which
# is a different shell with its own markup and sizes. Measured as what the
# renderer ended up showing, not as a key that arrived.
import types  # noqa: E402
try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for nm in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, nm, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import numpy as np  # noqa: E402
import py2Dmol  # noqa: E402

NB_JS = """<script>
window.addEventListener('load', async () => {
  //HELPERS
  const out = { errors: [] };
  try {
    const got = await until(() => {
      const v = Object.values(window.py2dmol_viewers || {})[0];
      return v && v.renderer.coords.length && v.renderer._slots;
    }, 8000);
    const r = Object.values(window.py2dmol_viewers)[0].renderer;
    await settle(6);
    out.slots = r.getSlots();
    const body = r._slots.layout.slots[0].body;
    // EVERY SLOT IS THE SAME SIZE HERE, which is the notebook's half of the
    // rename: the sizes 600 and 340 were the website's, and in a shell with
    // no stylesheet of its own "big" and "small" were two names for the one
    // number the caller passed as size=.
    out.boxes = r._slots.layout.slots.map((sl) => {
      const b = sl.body.getBoundingClientRect();
      return [Math.round(b.width), Math.round(b.height)];
    });
    // 🔴 AND THE DRAG. The website's stylesheet states this shell's sizes and
    // the FLOOR under them; the drag itself is the shared stylesheet's, for
    // every slot, so this is where a shell with no CSS of its own is checked.
    // The regression that reached a release was exactly this: #canvasContainer
    // carried resize: both, a view in a slot is 100% !important, and the
    // notebook's viewer quietly stopped being draggable while still showing a
    // corner triangle that said it was.
    // 🔴 THE OBJECT PICKER IS SHOWN FOR ONE OBJECT TOO, AND THIS IS THE ONE
    // SHELL THAT CAN SAY SO. It used to hide itself wherever it was all its
    // row held - which is exactly here: viewer.html gives it a row of its
    // own, where the website's also holds Multi and prev/next and was always
    // exempt. The reasoning was that a dropdown with one entry can only say
    // what it already says; what it costs is the one place the page NAMES
    // the fold on screen, with every panel under it editing the object
    // named there. tests/minimal_input.py cannot ask - its payload carries
    // seven objects - and this viewer carries exactly one.
    {
      const sel = document.getElementById('objectSelect');
      const row = sel && sel.closest('.toggle-item');
      out.picker = {
        options: sel ? [...sel.options].map((o) => o.value) : null,
        rowShown: row ? getComputedStyle(row).display !== 'none' : null,
        names: Object.keys(r.objectsData || {}),
      };
    }
    out.resize = getComputedStyle(body).resize;
    out.knob = [...body.querySelectorAll('.py2dmol-slot-knob')]
      .filter((h) => getComputedStyle(h).display !== 'none').length;
    out.viewHandles = [...body.querySelectorAll('.resize-handle')]
      .filter((h) => getComputedStyle(h).display !== 'none').length;
    const was = r.heatmapRenderer && r.heatmapRenderer.canvas.width;
    body.style.width = '520px'; body.style.height = '300px';
    await settle(8);
    out.dragged = [was, r.heatmapRenderer && r.heatmapRenderer.canvas.width];
  } catch (e) { out.errors.push(String(e && e.stack || e)); }
  await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
});
</script>""".replace('//HELPERS', HELPERS)
check_js(NB_JS)
N = 60
ii = np.arange(N)
dd = np.abs(ii[:, None] - ii[None, :])
CO = np.stack([8 * np.cos(ii * 0.6), 8 * np.sin(ii * 0.6), ii * 1.5], 1)
nbv = py2Dmol.view(pae=True, size=(420, 420))
nbv.add(CO, name='m', pae=np.minimum(30, dd * 0.3),
        maps={'contact': {'data': np.exp(-dd / 6.0), 'vmin': 0, 'vmax': 1}})
nbv.set_slots('contact')
page = ('<!doctype html><html><head><meta charset="utf-8"></head><body>'
        + nbv._display_viewer(static_data=nbv.objects) + NB_JS + '</body></html>')
NB = serve_and_read(page, 9301, '/tmp/py2dmol-slots-nb')
print(f"  notebook  {NB}")
bad += [f"notebook: {e}" for e in NB.get('errors') or []]
if (NB.get('slots') or [None])[0] != 'contact':
    bad.append(f"view.set_slots('contact') before show() came up as"
               f" {NB.get('slots')} - the config key did not reach the slots")
if NB.get('resize') != 'both' or NB.get('knob') != 1 or NB.get('viewHandles') != 0:
    bad.append(f"the notebook's first slot resizes {NB.get('resize')!r} with"
               f" {NB.get('knob')} knob and {NB.get('viewHandles')} view handles"
               " - the body carries the drag and its cue in every shell")
pk = NB.get('picker') or {}
print(f"  picker    {pk}")
if len(pk.get('names') or []) != 1:
    bad.append(f"the picker leg wanted one object, not {pk.get('names')}")
elif not pk.get('rowShown'):
    bad.append(f"the object picker is hidden with one object: {pk} - it is"
               " the only place the page names the fold on screen, and every"
               " panel below it edits the object named there")
elif (pk.get('options') or []) != (pk.get('names') or []):
    bad.append(f"the picker does not offer the object that is loaded: {pk}")

nd = NB.get('dragged') or [0, 0]
if not (nd[1] and nd[1] != nd[0]):
    bad.append(f"dragging the notebook's first slot did not reach the plot: {nd}")
if (NB.get('boxes') or [[0, 0]])[0] != [420, 420]:
    bad.append(f"the notebook's first slot is {(NB.get('boxes') or [None])[0]},"
               " not the 420x420 the view asked for - the size token has to"
               " move to the slot")
# 🔴 AND THE SECOND SLOT IS THE SAME SIZE, which is what the numbering bought
# in this shell. It used to be heatmap_size (300 by default) beside a 420
# structure, for no reason a caller could see: the panel's size is what a MAP
# is - the resample cap and the panel outside a slot - and not what a box in a
# row of boxes is.
if NB.get('boxes') != [[420, 420], [420, 420]]:
    bad.append(f"the notebook's slots are {NB.get('boxes')} - every slot is"
               " the size the caller asked the VIEWER for, and 'big'/'small'"
               " were two names for that one number here")

if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('slots: ok')
