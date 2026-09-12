"""Ghosting a selection: it must change the picture and rebuild nothing.

    python3 tests/opacity.py

WHAT IT IS FOR. A side chain inside the fold is drawn, is in the scene, and is
hidden by the cartoon in front of it from every angle - so reorienting the
camera, which is what people reach for, is not a fix. Reported against a
conference-talk build, where the caller confirmed `sidechains.size === 25` and
still could not see them. The answer is to fade the backbone over it.

🔴 AND IT IS A TEXEL, NOT A MESH, WHICH IS THE WHOLE CLAIM. cartoon/paintgl.js
already keeps one texel per residue that the vertex shader tests every face
against, and the fragment shader already fades the clip slab by DROPPING PIXELS
on an ordered 4x4 dither rather than blending. An opacity composes with the
slab through both: `min(clipCover(z), fade)`. So a fade is one texSubImage2D
per residue - no capture, no geometry, no rebuild - and a gate that only
checked the picture would pass just as well against a version that rebuilt the
mesh on every drag of the slider, which is the thing this port is built not to
do.

WHAT IS MEASURED:

  * a fade CHANGES PIXELS, by a lot, and putting it back restores the picture
    EXACTLY - byte for byte against the frame before it, which is the control
    that says the texel path leaves nothing behind;
  * across the whole sweep the mesh build stamp never moves;
  * 0 hides and 1 is solid, so the two ends still mean what every existing
    caller of that texel meant by them;
  * the OUTLINES FADE WITH THE FILLS. They did not at first - the ink pass had
    no residue index and its instance row was exactly nineteen floats - and a
    ghosted region was a line drawing at full strength over a faded fill. A
    face already carries `f.res`, which is the value the fills shader looks up,
    so the row is twenty floats now and the ink reads the same texel. Measured
    at every residue faded to nothing: 1,528 dark pixels before, 0 after.

  * ...AND SO DOES THE TUBE, whose own program never touched that texture at
    all - a fade there moved 0 pixels, on the style large structures default
    to. Its instances carry the two residues each segment runs between and
    average them, so a segment between a ghosted residue and a solid one is
    half faded rather than snapping to one end.
"""
import http.server, json, os, shutil, socketserver, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, '_opacity.html')
PORT, DBG = 9671, 9234

JS = """
<script>
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async () => {
   try {
    const txt = await (await fetch('/1UBQ.cif')).text();
    await window.processFiles([{name: '1UBQ.cif',
        readAsync: () => Promise.resolve(txt)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    if (!r.gpuDrewLastFrame) return {skip: 'this browser drew on the CPU path'};

    const cv = document.querySelector('#canvas');
    const shot = () => {
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      c.getContext('2d').drawImage(cv, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4)
        if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) n += 1;
      return n;
    };
    // how much INK is in a box - a dark pixel, whatever the fill did
    // 🔴 THE THRESHOLD IS MEASURED, NOT PICKED. The first one here was "under
    // 90 in every channel", which found ONE pixel in the whole drawing and so
    // made the outline check below pass by finding nothing. This is a paper
    // drawing in pastels: its darkest pixels sit at a luminance around 70 and
    // the bulk of the structure between 100 and 160, printed by the histogram
    // beside every row so the constant can be re-checked rather than trusted.
    const ink = (d) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4)
        if ((d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000 < 160) n += 1;
      return n;
    };
    // ...and the distribution behind that threshold, because a constant picked
    // by eye is how a check comes to pass by finding nothing
    const hist = (d) => {
      const h = new Array(8).fill(0);
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000;
        h[Math.min(7, Math.floor(l / 32))] += 1;
      }
      return h;
    };
    const stamp = () => {
      const R = window.__rebuild;
      return (R && R.t0 !== undefined) ? R.t0 : -1;
    };

    // HALF THE CHAIN, so there is something faded and something not - a whole
    // structure at one opacity cannot tell a per-residue texel from a global
    // uniform, and this port has no global one to confuse it with.
    const n = r.coords.length;
    const half = [];
    for (let i = 0; i < Math.floor(n / 2); i += 1) half.push(i);

    await settle(4);
    const solid = shot();
    const builds = [stamp()];
    const steps = [];
    // ...AND ONE ARM THAT FADES EVERYTHING, which is the only way to ask what
    // is left when the fills are gone. Half the chain faded leaves the other
    // half's ink in the frame, so the outline question cannot be answered from
    // it - the drawing would look the same whether or not the ghosted half
    // kept a single line.
    for (const a of [0.6, 0.3, 0.05, 0.0, 1.0, 'all0']) {
      if (a === 'all0') r.setOpacity(null, 0);
      else r.setOpacity({positions: half}, a);
      r.render();
      await settle(3);
      const d = shot();
      builds.push(stamp());
      steps.push({a, changed: diff(solid, d), ink: ink(d), hist: hist(d)});
    }
    // 🔴 AND WHETHER THOSE SURVIVING PIXELS ARE THE OUTLINES, asked rather
    // than assumed. A fraction left over after the fills go could be
    // antialiasing, a shadow, anything - so the same all-faded frame is drawn
    // AGAIN with the outline width at zero. If what remains is ink, this arm
    // is very nearly blank paper; if it is not, the two arms agree and the
    // check above was reading something else.
    const keptW = r.relativeOutlineWidth;
    r.relativeOutlineWidth = 0;
    if (r.invalidateMesh) r.invalidateMesh();
    r.render();
    await settle(4);
    const noInk = ink(shot());
    r.relativeOutlineWidth = keptW;
    r.setOpacity(null, 1);
    if (r.invalidateMesh) r.invalidateMesh();
    r.render();
    await settle(4);
    const back = shot();

    // 🔴 THE FADE BELONGS TO THE OBJECT, and both halves of that were wrong
    // in turn. Keyed by DRAWN position on the renderer, it followed the
    // indices into the next structure loaded - 38 residues of a protein that
    // had nothing to do with it came up faded. Guarding that by dropping the
    // fade whenever the position count changed then LOST IT the moment
    // anything was added, which is the ordinary way a notebook is used.
    // Stored against the object in the object's own numbering, like its side
    // chains and its base plates, neither can happen.
    r.setOpacity({positions: half}, 0.1);
    r.render(); await settle(4);
    const firstName = r.currentObjectName;
    const other = await (await fetch('/6MRR.cif')).text();
    await window.processFiles([{name: '6MRR.cif',
        readAsync: () => Promise.resolve(other)}], true);
    await until(loaded, 60000);
    if (r.setStyle) r.setStyle('cartoon');
    await settle(10);
    const arrived = shot();
    // ...counted as a plain object, which is what OBJECT_STATE's `plain` kind
    // is and what remapPositionMap renumbers - see src/core/objstate.js.
    const held = (o) => Object.keys((o || {}).opacity || {}).length;
    const heldAcross = held(r.objectsData[firstName]);
    const appliedAcross = (r.drawnOpacity() || new Map()).size;
    r.setOpacity(null, 1); r.render(); await settle(6);
    const solidThere = diff(arrived, shot());
    // ...AND GOING BACK TO THE FIRST ONE STILL FINDS IT GHOSTED, which is the
    // half a "drop it when anything changes" guard passes and a reader does
    // not forgive.
    r._switchToObject(firstName); r.setFrame(0); await settle(10);
    const backOn = shot();
    const appliedOnReturn = (r.drawnOpacity() || new Map()).size;
    r.setOpacity(null, 1); r.render(); await settle(8);
    const stillFaded = diff(backOn, shot());
    // ...AND IN A MERGED VIEW IT LANDS AT THAT OBJECT'S OFFSET. The map is in
    // the object's own numbering and the picture is one array; showing both is
    // the only arm where the two differ, so it is the only one that can catch
    // an offset dropped on the way through.
    // 🔴 GHOSTING THE SECOND OBJECT, NOT THE FIRST. The first sits at offset 0
    // in the merge, so its own numbering and the drawn array's are the same
    // numbers and an offset dropped on the way through is invisible. The
    // second starts where the first ends, which is the only place the two can
    // disagree.
    r.setShownObjects([firstName, '6MRR']);
    await settle(12);
    r.setOpacity({object: '6MRR', positions: half}, 0.1);
    r.render(); await settle(8);
    const mergedFaded = (r.drawnOpacity() || new Map());
    const mergedCount = mergedFaded.size;
    const mergedMin = mergedCount ? Math.min(...mergedFaded.keys()) : -1;
    const mergedMax = mergedCount ? Math.max(...mergedFaded.keys()) : -1;
    const mergedOff = r.localRangeOf ? (r.localRangeOf('6MRR').off || 0) : 0;
    r.setOpacity({object: '6MRR'}, 1);
    r.setShownObjects([firstName]);
    await settle(10);
    r.setOpacity(null, 1); r.render(); await settle(6);

    // 🔴 AND A PARTIAL FADE, WHICH IS THE ONLY ARM THAT SEES THE INK FADE AT
    // ALL. At opacity 0 the vertex shader drops the instance before the
    // coverage is ever used, so "everything vanished" is the HIDE path and
    // says nothing about the dither: stripping the ink's fade entirely left
    // this gate green until this arm existed. Half coverage keeps every
    // instance and halves its pixels, ink included.
    //
    // 🔴 AND IT IS ISOLATED BY DIFFERENCE, NOT COUNTED. A count of dark pixels
    // does not measure ink: dithering half a SOLID fill away lets paper
    // through and puts MORE pixels in the mid band than the solid fill had -
    // measured, 14,008 at half coverage against 11,801 solid. What the ink is,
    // exactly, is the pixels that change when the outline width goes to zero.
    const inkAt = async (alpha) => {
      r.setOpacity(null, alpha);
      r.render(); await settle(6);
      const on = shot();
      const kept = r.relativeOutlineWidth;
      r.relativeOutlineWidth = 0;
      if (r.invalidateMesh) r.invalidateMesh();
      r.render(); await settle(6);
      const off = shot();
      r.relativeOutlineWidth = kept;
      if (r.invalidateMesh) r.invalidateMesh();
      r.render(); await settle(6);
      return diff(on, off);
    };
    const inkSolid = await inkAt(1);
    const inkHalf = await inkAt(0.5);
    r.setOpacity(null, 1); r.render(); await settle(6);

    // ...AND THE TUBE, on the style a large structure defaults to.
    if (r.setStyle) r.setStyle('tube');
    await settle(10);
    r.setOpacity(null, 1); r.render(); await settle(6);
    const tubeSolid = shot();
    r.setOpacity({positions: half}, 0.1); r.render(); await settle(6);
    const tubeMoved = diff(tubeSolid, shot());
    r.setOpacity(null, 1);

    // ...AND THE PANEL OFFERS THE CONTROL IN BOTH, now that both can honour
    // it. It withheld the row in tube while that was untrue, so this is the
    // half that says the withholding was lifted when the reason went.
    const rowHidden = () => {
      const row = document.querySelector('#opacityRow');
      if (!row) return null;
      return !!row.hidden || getComputedStyle(row).display === 'none';
    };
    r.setResidueSelection([1, 2, 3]);
    if (window.updateSelectionToolsState) window.updateSelectionToolsState();
    await settle(4);
    const rowInTube = rowHidden();
    if (r.setStyle) r.setStyle('cartoon');
    await settle(10);
    r.setResidueSelection([1, 2, 3]);
    if (window.updateSelectionToolsState) window.updateSelectionToolsState();
    await settle(4);
    const rowInCartoon = rowHidden();
    r.clearResidueSelection();

    return {
      heldAcross, appliedAcross, solidThere, tubeMoved,
      appliedOnReturn, stillFaded, mergedCount, mergedMin, mergedMax, mergedOff,
      inkSolid, inkHalf,
      rowInTube, rowInCartoon,
      positions: n, faded: half.length,
      solidInk: ink(solid), solidHist: hist(solid),
      steps,
      restored: diff(solid, back), allZeroNoOutline: noInk,
      rebuilt: new Set(builds).size - 1,
      sawStamp: builds[0] !== -1,
    };
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
</script>
"""
open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read()
                       .replace('</body>', JS.replace('//HELPERS', HELPERS) + '</body>'))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-opacity")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_opacity.html")
    wait_for(ws, "window.__ready === true", timeout=90, what="the page")
    R = json.loads(evaluate(ws, "window.__go().then(JSON.stringify)"))
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree("/tmp/py2dmol-opacity", ignore_errors=True)

if R.get('error'):
    sys.exit("page error: " + R['error'])
if R.get('skip'):
    print("opacity: skipped - " + R['skip'])
    sys.exit(0)

bad = []
print(f"  {R['positions']} positions, {R['faded']} of them faded,"
      f" solid ink {R['solidInk']} px")
for s in R['steps']:
    print(f"    opacity {str(s['a']):<5} {s['changed']:>7} px differ, ink {s['ink']:>6}")
print(f"  solid histogram (luminance bands of 32): {R['solidHist']}")
for s in R['steps']:
    print(f"    {str(s['a']):<5} {s['hist']}")
print(f"  all faded: {R['steps'][-1]['ink']} ink px, and"
      f" {R['allZeroNoOutline']} with the outlines off")
print(f"  restored to {R['restored']} px difference, mesh rebuilt {R['rebuilt']}x")
print(f"  across a load: {R['heldAcross']} kept on the first object,"
      f" {R['appliedAcross']} applied while the new one is drawn,"
      f" {R['solidThere']} px between its arrival and fully solid")
print(f"  back on the first: {R['appliedOnReturn']} applied,"
      f" {R['stillFaded']} px of fade still in the picture")
print(f"  merged: the SECOND object's {R['mergedCount']} ghosted positions land"
      f" at {R['mergedMin']}..{R['mergedMax']}; it starts at {R['mergedOff']}")
print(f"  the outlines themselves: {R['inkSolid']} px solid,"
      f" {R['inkHalf']} px at half coverage")
print(f"  tube: a fade moves {R['tubeMoved']} px;"
      f" the Opacity row is hidden={R['rowInTube']} there"
      f" and hidden={R['rowInCartoon']} in cartoon")

if not R.get('sawStamp'):
    bad.append("there is no window.__rebuild stamp on this page, so the"
               " rebuild count below means nothing")
if R['rebuilt'] != 0:
    bad.append(f"the sweep rebuilt the mesh {R['rebuilt']} time(s) - a fade is"
               " a texel write and must touch no geometry")
by = {s['a']: s for s in R['steps']}
if by[0.6]['changed'] < 1000:
    bad.append(f"opacity 0.6 moved {by[0.6]['changed']} px - it drew"
               " essentially the same picture")
if by[0.05]['changed'] <= by[0.6]['changed']:
    bad.append(f"a heavier fade moved FEWER pixels ({by[0.05]['changed']}"
               f" against {by[0.6]['changed']}) - the value is not reaching"
               " the dither")
if by[0.0]['changed'] <= by[0.05]['changed']:
    bad.append("opacity 0 did not hide more than 0.05 did, so the two ends of"
               " the range do not mean what every caller of that texel means")
# THE INK SURVIVES. The outlines were deliberately left solid; a ghosted
# region is a line drawing over a faded fill, and at 0.05 there must still be
# ink where the fill has gone.
all0 = by['all0']
# EVERYTHING FADED TO NOTHING LEAVES NOTHING - fills and outlines alike. The
# outlines-off arm is the control: if the two differ, something is still being
# drawn that the fade does not reach.
if all0['ink'] > R['solidInk'] * 0.02:
    bad.append(f"with every residue at opacity 0 there are still {all0['ink']}"
               f" dark pixels of {R['solidInk']} - something survives the fade")
if all0['ink'] != R['allZeroNoOutline']:
    bad.append(f"every residue faded to 0 leaves {all0['ink']} dark pixels with"
               f" outlines on and {R['allZeroNoOutline']} with them off - the"
               ' ink is not fading with the fill it outlines')
if R['restored'] != 0:
    bad.append(f"putting the opacity back to 1 left {R['restored']} px"
               " different from before the sweep - the texel path leaves"
               " something behind")

if R['heldAcross'] == 0:
    bad.append('the first object lost its fade when another was added - it is'
               " the object's own and adding a second cannot touch it")
if R['appliedAcross'] != 0:
    bad.append(f"{R['appliedAcross']} residues are ghosted while the NEW object"
               ' is the one drawn - the fade followed the indices into it')
if R['solidThere'] != 0:
    bad.append(f"the new structure arrived {R['solidThere']} px away from fully"
               ' solid - something of the other one\'s fade reached the picture')
if R['appliedOnReturn'] != R['heldAcross'] or R['stillFaded'] < 1000:
    bad.append(f"going back to the first object applied {R['appliedOnReturn']}"
               f" of its {R['heldAcross']} and left {R['stillFaded']} px of"
               ' fade in the picture - it was kept and then not used')
# ...and the offset. Merged, the first object's positions start at its offset,
# so a fade written in its own numbering has to be read back shifted by it.
# THE SECOND OBJECT'S FADE, READ BACK IN THE MERGED ARRAY. Its positions are
# its own 0..37 and must appear at its OFFSET; landing at 0..37 means the
# mapping was skipped, and the FIRST object's residues are the ones ghosted.
if not R['mergedOff']:
    bad.append('the second object sits at offset 0 in the merge, so this arm'
               ' cannot tell a mapped index from an unmapped one')
elif R['mergedCount'] != 38:
    bad.append(f"merged, {R['mergedCount']} of 38 ghosted positions survived"
               ' the mapping')
elif R['mergedMin'] < R['mergedOff']:
    bad.append(f"merged, the second object's fade lands at {R['mergedMin']}.."
               f"{R['mergedMax']} and it starts at {R['mergedOff']} - the"
               ' offset was dropped')
# THE INK'S SHARE, AND THAT IT FADED. With every residue at half coverage the
# outlines keep about half their pixels; leaving them at full strength puts
# them all back, which is the state this arm was written to catch.
if R['inkSolid'] < 500:
    bad.append(f"the outlines are only {R['inkSolid']} px at full strength -"
               ' this arm is not measuring ink, so what follows means nothing')
if R['inkHalf'] >= R['inkSolid'] * 0.8:
    bad.append(f"the outlines are {R['inkHalf']} px at half coverage against"
               f" {R['inkSolid']} solid - the ink is not fading with the fill"
               ' it outlines')
if R['tubeMoved'] < 1000:
    bad.append(f"a fade in TUBE style moved {R['tubeMoved']} px - the tube's"
               ' own program reads the same coverage texture, and a large'
               ' structure defaults to that style')

if R['rowInTube'] is None or R['rowInCartoon'] is None:
    bad.append('there is no #opacityRow on this page, so neither half of the'
               ' check below means anything')
elif R['rowInTube'] or R['rowInCartoon']:
    bad.append(f"the Opacity row is hidden in tube={R['rowInTube']},"
               f" cartoon={R['rowInCartoon']} - both can fade now, so the row"
               ' belongs in both')

print()
for b in bad:
    print("FAIL: " + b)
print("opacity: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
