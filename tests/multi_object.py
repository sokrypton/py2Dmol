"""Two objects on screen at once, in a real browser.

    python3 tests/multi_object.py 1BBH.cif 1HVR.cif --png /tmp/multi.png

What it checks, once the merge is switched on with setShownObjects:

  - both objects' positions are in ONE coordinate array, and the source map
    covers every one of them;
  - no segment joins two objects - the failure that a merge invites and that
    nothing in the drawing would make obvious, since a bond across the gap
    between two structures looks like a long bond, not like a bug;
  - each object is drawn in a colour of its own;
  - the picture actually changes: ink counted with one object showing and with
    both, in ONE page load (the paper grain is re-seeded per load, so across
    loads a comparison measures the grain - see tests/README.md);
  - and the same again with the GPU path on, since a merged array is one
    structure as far as it is concerned and it should need no new code.

Same two traps as tests/gpu_bench.py: the page POSTs its result back rather
than being scraped, and every local script src is stamped per run.
"""
import argparse, base64, http.server, json, os, re, shutil, socketserver
import subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_multi_probe.html")

PAGE_JS = """
<script>
window.addEventListener('load', () => {
  const P = new URLSearchParams(location.search);
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  // ink: how many pixels are not the background, so "did the picture change"
  const ink = (r) => {
    const c = r.canvas, x = c.getContext('2d');
    if (!x) return -1;
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) n++;
    }
    return n;
  };
  const go = async () => {
    const R = {};
    try {
      const gc = document.createElement('canvas').getContext('webgl2');
      const dbg = gc && gc.getExtension('WEBGL_debug_renderer_info');
      R.renderer = dbg ? gc.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?';
      await load(P.get('a'));
      await load(P.get('b'));
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      const names = Object.keys(r.objectsData);
      R.objects = names;

      // A PLAIN LOAD, BEFORE ANY API CALL. This is how a user gets here -
      // fetch one structure, fetch another - and the resting state is ONE
      // object on screen, the one the picker names, exactly as the viewer has
      // always behaved. Loading a second file does not change what you are
      // looking at, and does not merge anything.
      R.plainDrawn = r.drawnObjects();
      R.plainN = r.coords.length;
      R.plainMulti = !!(r.multiState && r.multiState.enabled);
      R.plainVisible = r.visiblePositions ? r.visiblePositions.size : r.coords.length;

      r.setShownObjects([names[0]]);
      r.render('one');
      await new Promise((s) => setTimeout(s, 200));
      R.oneInk = ink(r);
      R.oneN = r.coords.length;

      r.setShownObjects(names);
      r.render('both');
      await new Promise((s) => setTimeout(s, 200));
      R.bothInk = ink(r);
      if (P.get('png') === '1') R.pngCpu = r.canvas.toDataURL('image/png');
      R.bothN = r.coords.length;
      R.multi = !!(r.multiState && r.multiState.enabled);
      R.sources = r.multiState ? r.multiState.sourceNames : null;
      R.offsets = r.multiState ? r.multiState.sourceOffsets : null;

      // every position mapped, and no segment across the join
      const g = r.sourceGroups();
      R.mapLen = g ? g.length : -1;
      let crossing = 0;
      for (const s of r.segmentIndices) {
        if (s.idx2 === undefined || s.idx2 === s.idx1) continue;
        if (g[s.idx1] !== g[s.idx2]) crossing++;
      }
      R.crossing = crossing;
      R.segments = r.segmentIndices.length;
      R.autoColor = r.resolvedAutoColor;

      // one colour per object: sample the colour of a position from each
      const cols = {};
      for (let s = 0; s < R.sources.length; s++) {
        const at = R.offsets[s];
        const c = r.getAtomColor(at, r._getEffectiveColorMode());
        cols[R.sources[s]] = [c.r, c.g, c.b].join(',');
      }
      R.colors = cols;
      R.autos = r.multiState ? r.multiState.sourceAutoColors : null;
      // NO COLOUR SHARED ACROSS THE JOIN. Both structures have a chain A, and
      // under the chain scheme that came out the same colour for both - two
      // molecules reading as one. Sampled from the drawing, per source.
      const bySource = [new Set(), new Set()];
      for (let i = 0; i < r.coords.length; i++) {
        const src = g[i];
        if (src !== 0 && src !== 1) continue;
        const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
        bySource[src].add([c.r, c.g, c.b].join(','));
      }
      R.perSource = bySource.map((x) => Array.from(x));
      R.sharedColors = R.perSource[0].filter((c) => R.perSource[1].includes(c));
      R.modes = {global: r.colorMode, effective: r._getEffectiveColorMode(),
        perObject: r.objectsData[r.currentObjectName].colorMode,
        resolvedAuto: r.resolvedAutoColor};
      // what the DRAWING used: the distinct segment colours actually painted
      const sc = r._calculateSegmentColors();
      const tally = {};
      for (let i = 0; i < sc.length; i++) {
        const k = [sc[i].r, sc[i].g, sc[i].b].join(',');
        tally[k] = (tally[k] || 0) + 1;
      }
      R.painted = tally;

      // A PER-OBJECT SET, EDITED THROUGH THE MERGE. Hiding the second
      // object's backbone must land on the second object, in its own
      // numbering, and leave the first one alone and fully drawn.
      const off1 = R.offsets[1];
      const hide = [];
      for (let i = off1; i < r.coords.length && i < off1 + 40; i++) hide.push(i);
      r.setBackboneHiddenFor(hide, true);
      r.render('hidden');
      await new Promise((s) => setTimeout(s, 200));
      R.hiddenInk = ink(r);
      R.hiddenOnFirst = !!(r.objectsData[R.sources[0]].hiddenBackbone);
      const hb = r.objectsData[R.sources[1]].hiddenBackbone;
      R.hiddenLocal = hb ? Math.min(...hb) : -1;
      r.setBackboneHiddenFor(hide, false);
      r.render('unhidden');
      await new Promise((s) => setTimeout(s, 200));
      R.restoredInk = ink(r);

      // ...and the Object colour mode, which is only offered when there is
      // more than one object to tell apart.
      const colorSel = document.getElementById('colorSelect');
      const objOpt = colorSel && colorSel.querySelector('option[value="object"]');
      R.objectOptionShown = !!(objOpt && !objOpt.hidden);
      if (objOpt) {
        colorSel.value = 'object';
        colorSel.dispatchEvent(new Event('change'));
        r.render('object mode');
        await new Promise((s) => setTimeout(s, 200));
        const flat = {};
        for (let i = 0; i < r.coords.length; i++) {
          const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
          (flat[g[i]] = flat[g[i]] || new Set()).add([c.r, c.g, c.b].join(','));
        }
        R.flatPerObject = Object.values(flat).map((x) => x.size);
        colorSel.value = 'auto';
        colorSel.dispatchEvent(new Event('change'));
        r.render('back to auto');
        await new Promise((s) => setTimeout(s, 150));
      }

      // ORIENT, PICKING AND AUTO CLIP, the three things that ask "where is the
      // structure" and used to be answered by the current object alone.
      window.applyBestViewRotation(false);
      await new Promise((s) => setTimeout(s, 300));
      R.orientInk = ink(r);
      r._ensurePickProjection();
      let outside = 0;
      for (let i = 0; i < r.coords.length; i++) {
        if (!r.screenValid || !r.screenValid[i]) continue;
        const x = r.screenX[i]; const y = r.screenY[i];
        if (x < 0 || y < 0 || x > r.displayWidth || y > r.displayHeight) outside++;
      }
      R.outsideAfterOrient = outside;

      // pick where the SECOND object is drawn: the hit must belong to it.
      // pickResidueAt takes CLIENT coordinates and subtracts the canvas rect.
      const probe = R.offsets[1] + 5;
      r._ensurePickProjection();
      const rect = r.canvas.getBoundingClientRect();
      const hit = r.pickResidueAt(r.screenX[probe] + rect.left,
        r.screenY[probe] + rect.top);
      R.pickHit = hit;
      R.pickOwner = (hit >= 0 && r.ownerOf) ? (r.ownerOf(hit) || {}).name : null;

      // auto clip on a selection in the second object
      r.setResidueSelection(new Set([probe]));
      if (r.autoClip) r.autoClip(r.residueSelection);
      r.render('clipped');
      await new Promise((s) => setTimeout(s, 200));
      R.clipInk = ink(r);
      R.clipSlab = [r.clipNear, r.clipFar];
      r.setClipSlab(null, null);
      r.clearResidueSelection();
      r.render('unclipped');
      await new Promise((s) => setTimeout(s, 200));

      // THE TUBE STYLE, which has a GPU program of its own (VSTUBE) and its
      // own joint handling - a merged array must be one structure to it too.
      const styleWas = r.style;
      r.setStyle('tube');
      r.render('tube cpu');
      await new Promise((s) => setTimeout(s, 250));
      R.tubeInk = ink(r);
      R.tubeCrossing = (() => {
        const gg = r.sourceGroups();
        let k = 0;
        for (const sg of r.segmentIndices) {
          if (sg.idx2 === undefined || sg.idx2 === sg.idx1) continue;
          if (gg[sg.idx1] !== gg[sg.idx2]) k++;
        }
        return k;
      })();
      r.useGPU = true;
      r.render('tube gpu');
      await new Promise((s) => setTimeout(s, 400));
      R.tubeGpuInk = ink(r);
      R.tubeGpuTook = !!(r._tubeGPUWillTake && r._tubeGPUWillTake());
      r.useGPU = false;
      r.setStyle(styleWas);
      r.render('back to cartoon');
      await new Promise((s) => setTimeout(s, 250));

      // THE LIST UI, driven as a user drives it: press the button, click a
      // row. ONE object is on screen to begin with; All is the row that puts
      // the rest up, and pressing it again takes everything off.
      r.setShownObjects(null);          // the resting state: just the edited one
      r.render('resting');
      await new Promise((s) => setTimeout(s, 200));
      const btn = document.getElementById('objectListButton');
      R.btnOne = btn.textContent;
      btn.click();
      const rows0 = Array.from(document.querySelectorAll('.object-list-row'));
      R.rows = rows0.map((x) => x.querySelector('.object-list-name').textContent);
      R.swatches = document.querySelectorAll('.object-list-swatch').length;
      R.oneObjectInk = ink(r);
      R.oneObjectDrawn = r.drawnObjects();

      rows0[0].click();                 // All on
      await new Promise((s) => setTimeout(s, 300));
      R.afterAllDrawn = r.drawnObjects();
      R.afterAllInk = ink(r);
      R.btnAll = document.getElementById('objectListButton').textContent;

      const rowsA = Array.from(document.querySelectorAll('.object-list-row'));
      rowsA[0].click();                 // All off - every object, an empty canvas
      await new Promise((s) => setTimeout(s, 300));
      R.noneDrawn = r.drawnObjects().length;
      R.noneInk = ink(r);
      R.noneObjectsKept = Object.keys(r.objectsData).length;
      R.btnNone = document.getElementById('objectListButton').textContent;

      // ONE OBJECT'S OWN EYE, from an empty canvas: it comes back on its own,
      // and it is NOT the object being edited - which the merge path draws
      // just as well as the plain one.
      const rowsB = Array.from(document.querySelectorAll('.object-list-row'));
      rowsB[1].click();
      await new Promise((s) => setTimeout(s, 300));
      R.oneBackDrawn = r.drawnObjects();
      R.oneBackInk = ink(r);
      R.oneBackIsEdited = r.drawnObjects()[0] === r.currentObjectName;

      // ...and the other joins it rather than replacing it, which is the
      // complaint that started all of this
      const rowsC = Array.from(document.querySelectorAll('.object-list-row'));
      rowsC[2].click();
      await new Promise((s) => setTimeout(s, 300));
      R.afterJoinDrawn = r.drawnObjects();
      R.afterJoinInk = ink(r);
      R.afterJoinMulti = !!(r.multiState && r.multiState.enabled);
      R.btnSome = document.getElementById('objectListButton').textContent;

      r.setShownObjects(names);
      r.render('all again');
      await new Promise((s) => setTimeout(s, 200));

      // THE PICKER, which is what says whose sequence the strip is showing.
      // It lives in the sequence header, outside the viewer container - the
      // renderer has to find it there or there is no way to switch objects.
      const picker = document.getElementById('objectSelect');
      R.pickerVisible = !!(picker && picker.offsetParent !== null);
      R.pickerOptions = picker
        ? Array.from(picker.options).map((o) => o.value) : null;
      R.pickerValue = picker ? picker.value : null;
      if (picker) {
        picker.value = names[0];
        picker.dispatchEvent(new Event('change'));
        await new Promise((s) => setTimeout(s, 350));
      }
      R.afterPickCurrent = r.currentObjectName;
      R.afterPickDrawn = r.drawnObjects();

      // ...and the GPU path, in the SAME page load
      r.useGPU = true;
      r.render('gpu');
      await new Promise((s) => setTimeout(s, 400));
      R.gpuInk = ink(r);
      R.gpuTook = !!(r._gpuWillDraw && r._gpuWillDraw());
      R.gpuError = String(window.__gpuLastError || '');
      if (P.get('png') === '1') R.png = r.canvas.toDataURL('image/png');
      r.useGPU = false;
      r.render('back');
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""


def build_probe():
    src = open(os.path.join(ROOT, "index.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src.replace("</body>", PAGE_JS + "</body>"))


def serve(port, box):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, *a):
            pass

        def do_POST(self):
            box.append(json.loads(self.rfile.read(
                int(self.headers.get("Content-Length", 0)))))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a", help="a structure file in the repo root")
    ap.add_argument("b", help="another one")
    ap.add_argument("--port", type=int, default=8933)
    ap.add_argument("--png")
    ap.add_argument("--timeout", type=int, default=180)
    a = ap.parse_args()
    if not os.path.exists(CHROME):
        sys.exit("Google Chrome not found at " + CHROME)
    build_probe()
    box = []
    httpd = serve(a.port, box)
    url = (f"http://127.0.0.1:{a.port}/_multi_probe.html?a={a.a}&b={a.b}"
           + ("&png=1" if a.png else ""))
    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--user-data-dir=/tmp/py2dmol-multi-{os.getpid()}",
         "--no-first-run", "--disable-extensions", "--window-size=1200,1200", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + a.timeout
    while not box and time.time() < deadline:
        time.sleep(0.5)
    proc.kill()
    httpd.shutdown()
    shutil.rmtree(f"/tmp/py2dmol-multi-{os.getpid()}", ignore_errors=True)
    try:
        os.remove(PROBE)
    except OSError:
        pass
    if not box:
        sys.exit("no result posted within %ds" % a.timeout)
    R = box[0]
    if R.get("error"):
        sys.exit("page error: " + R["error"])
    png = R.pop("png", None)
    cpu = R.pop("pngCpu", None)
    if png and a.png:
        open(a.png, "wb").write(base64.b64decode(png.split(",", 1)[1]))
    if cpu and a.png:
        open(a.png.replace(".png", "_cpu.png"), "wb").write(
            base64.b64decode(cpu.split(",", 1)[1]))

    print(f"objects: {R['objects']} on {R['renderer']}")
    print(f"  plain load: drew {R.get('plainDrawn')}, {R.get('plainN')} positions,"
          f" merge {R.get('plainMulti')}, {R.get('plainVisible')} visible")
    print(f"  one:   {R['oneN']:6d} positions, {R['oneInk']:8d} ink")
    print(f"  both:  {R['bothN']:6d} positions, {R['bothInk']:8d} ink"
          f"  (merge {'on' if R['multi'] else 'OFF'}, offsets {R['offsets']})")
    print(f"  map covers {R['mapLen']} of {R['bothN']} positions")
    print(f"  {R['segments']} segments, {R['crossing']} of them across the join")
    print(f"  auto per object: {R.get('autos')}; first position of each:"
          f" {R['colors']}")
    print(f"  colours per object: {[len(x) for x in R.get('perSource', [])]},"
          f" shared: {R.get('sharedColors')}")
    print(f"  modes: {R.get('modes')}")
    print(f"  painted: {R.get('painted')}")
    print(f"  hiding 40 of the second object: {R['hiddenInk']} ink,"
          f" back to {R['restoredInk']}; first object touched:"
          f" {R['hiddenOnFirst']}, second object's lowest index {R['hiddenLocal']}")
    print(f"  list: rows {R.get('rows')}, swatches {R.get('swatches')};"
          f" button {R.get('btnOne')!r} -> {R.get('btnAll')!r} -> {R.get('btnNone')!r}")
    print(f"  All: {R.get('oneObjectDrawn')} ({R.get('oneObjectInk')} ink) ->"
          f" {R.get('afterAllDrawn')} ({R.get('afterAllInk')}) -> nothing"
          f" ({R.get('noneInk')} ink, {R.get('noneObjectsKept')} objects kept)")
    print(f"  eyes from empty: {R.get('oneBackDrawn')} ({R.get('oneBackInk')} ink)"
          f" -> {R.get('afterJoinDrawn')} ({R.get('afterJoinInk')} ink,"
          f" merge {R.get('afterJoinMulti')})")
    print(f"  picker: {R.get('pickerOptions')} showing {R.get('pickerValue')!r};"
          f" picking the other -> editing {R.get('afterPickCurrent')},"
          f" drawn {R.get('afterPickDrawn')}")
    print(f"  orient: {R.get('orientInk')} ink,"
          f" {R.get('outsideAfterOrient')} positions off canvas;"
          f" pick at the second object -> {R.get('pickOwner')};"
          f" clip {R.get('clipSlab')} leaves {R.get('clipInk')} ink")
    print(f"  Object mode offered: {R.get('objectOptionShown')},"
          f" colours per object in it: {R.get('flatPerObject')}")
    print(f"  tube:  {R.get('tubeInk')} ink, {R.get('tubeCrossing')} crossing;"
          f" gpu {R.get('tubeGpuInk')} (path taken: {R.get('tubeGpuTook')})")
    print(f"  gpu:   {R['gpuInk']:8d} ink (path taken: {R['gpuTook']})"
          + (f"  DECLINED: {R['gpuError']}" if R.get("gpuError") else ""))

    bad = []
    if R.get("plainDrawn") != [R["objects"][1]]:
        bad.append(f"a plain load of two files drew {R.get('plainDrawn')} - the"
                   " resting state is the object being edited, on its own")
    if R.get("plainMulti"):
        bad.append("a plain load merged two objects without being asked to")
    if R.get("plainVisible") != R.get("plainN"):
        bad.append(f"only {R.get('plainVisible')} of {R.get('plainN')} positions"
                   " are visible after a plain load")
    if not R["multi"]:
        bad.append("the merge did not switch on")
    if R["mapLen"] != R["bothN"]:
        bad.append("the source map does not cover every position")
    if R["crossing"]:
        bad.append(f"{R['crossing']} segments join two objects")
    if R.get("sharedColors"):
        bad.append(f"two objects share colours {R['sharedColors']}")
    if R["hiddenOnFirst"]:
        bad.append("hiding the second object's backbone wrote onto the first")
    if R["hiddenLocal"] != 0:
        bad.append("the second object's set is not in its own numbering")
    if R["hiddenInk"] >= R["bothInk"]:
        bad.append("hiding 40 residues did not remove any ink")
    if abs(R["restoredInk"] - R["bothInk"]) > 0.02 * R["bothInk"]:
        bad.append("unhiding did not restore the picture")
    if R.get("outsideAfterOrient"):
        bad.append(f"{R['outsideAfterOrient']} positions are off canvas after Orient")
    if R.get("pickOwner") != R["sources"][1]:
        bad.append(f"a pick on the second object reported {R.get('pickOwner')}")
    if not (0 < R.get("clipInk", 0) < R["bothInk"]):
        bad.append(f"auto clip on one object left {R.get('clipInk')} ink")
    if R.get("rows") != ["All"] + R["objects"]:
        bad.append(f"the list reads {R.get('rows')} - All first, then the objects")
    if R.get("swatches"):
        bad.append("the rows still carry colour swatches")
    if R.get("oneObjectDrawn") != [R["objects"][1]]:
        bad.append(f"the resting state drew {R.get('oneObjectDrawn')}")
    if R.get("btnOne") != "1/2":
        bad.append(f"the button reads {R.get('btnOne')!r} with one object on screen")
    if R.get("afterAllDrawn") != R["objects"]:
        bad.append(f"All left {R.get('afterAllDrawn')} on screen")
    if R.get("btnAll") != "All":
        bad.append(f"the button reads {R.get('btnAll')!r} after All")
    if not (R.get("afterAllInk", 0) > R.get("oneObjectInk", 0)):
        bad.append("All did not add any ink")
    if R.get("noneDrawn") != 0:
        bad.append(f"All switched off left {R.get('noneDrawn')} drawn")
    if R.get("noneInk", 1) != 0:
        bad.append(f"an empty canvas has {R.get('noneInk')} ink on it")
    if R.get("noneObjectsKept") != len(R["objects"]):
        bad.append("switching objects off unloaded them")
    if R.get("btnNone") != "0/2":
        bad.append(f"the button reads {R.get('btnNone')!r} with nothing on screen")
    if R.get("oneBackDrawn") != [R["objects"][0]]:
        bad.append(f"one eye from an empty canvas drew {R.get('oneBackDrawn')}")
    if R.get("oneBackIsEdited"):
        bad.append("this leg is meant to draw the object that is NOT being edited")
    if not R.get("oneBackInk"):
        bad.append("one eye from an empty canvas drew nothing")
    if R.get("afterJoinDrawn") != R["objects"]:
        bad.append(f"lighting a second eye left {R.get('afterJoinDrawn')} drawn -"
                   " it should JOIN what is on screen, not replace it")
    if not R.get("afterJoinMulti"):
        bad.append("two objects on screen are not merged")
    # NOT "more ink than before": adding an object re-frames the camera to fit
    # both, which SHRINKS the one that was there - 1BBH alone measured 82,800
    # ink and the pair 55,919. Ink is not a proxy for "something was added" the
    # moment the framing can change; the drawn list and the merge are.
    if not R.get("afterJoinInk"):
        bad.append("two objects on screen drew nothing")
    if R.get("btnSome") != "All":
        bad.append(f"the button reads {R.get('btnSome')!r} with both on screen")
    if not R.get("pickerVisible"):
        bad.append("the object picker is not visible beside the sequence")
    if R.get("pickerOptions") != R["objects"]:
        bad.append(f"the picker offers {R.get('pickerOptions')}")
    if R.get("afterPickCurrent") != R["objects"][0]:
        bad.append("picking an object did not change which one is being edited")
    if R.get("afterPickDrawn") != R["objects"]:
        bad.append(f"picking an object changed what is DRAWN:"
                   f" {R.get('afterPickDrawn')} - that is the bug this design fixes")
    if not R.get("objectOptionShown"):
        bad.append("the Object colour mode is not offered with two objects up")
    if R.get("flatPerObject") not in ([1, 1], None):
        bad.append(f"Object mode is not one colour per object: {R.get('flatPerObject')}")
    if R.get("tubeCrossing"):
        bad.append(f"{R['tubeCrossing']} tube segments join two objects")
    if not R.get("tubeInk"):
        bad.append("the tube style drew nothing")
    if abs(R.get("tubeGpuInk", 0) - R.get("tubeInk", 1)) > 0.2 * R.get("tubeInk", 1):
        bad.append("the GPU tube picture is not the CPU one")
    if R["gpuInk"] <= 0:
        bad.append("the GPU path drew nothing")
    if abs(R["gpuInk"] - R["bothInk"]) > 0.15 * R["bothInk"]:
        bad.append("the GPU picture is not the CPU one")
    for m in bad:
        print("FAIL:", m)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
