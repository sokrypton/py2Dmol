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

      // THE LIST UI, driven as a user drives it: press Object, then the eye
      // on the row that is not showing.
      r.setShownObjects([names[0]]);
      r.render('one again');
      await new Promise((s) => setTimeout(s, 150));
      const btn = document.getElementById('objectListButton');
      btn.click();
      const rows = Array.from(document.querySelectorAll('.object-list-row'));
      R.rows = rows.map((x) => x.querySelector('.object-list-name').textContent);
      const cur = rows.findIndex((x) => x.classList.contains('is-current'));
      R.currentRow = cur;
      R.currentMarked = cur >= 0 && R.rows[cur] === r.currentObjectName;
      R.hiddenRows = rows.filter((x) => x.classList.contains('is-hidden')).length;
      rows[1].querySelector('.object-list-eye').click();
      await new Promise((s) => setTimeout(s, 250));
      R.afterEyeInk = ink(r);
      R.afterEyeMulti = !!(r.multiState && r.multiState.enabled);
      // the last visible object cannot be hidden - the eye would look broken
      const rows2 = Array.from(document.querySelectorAll('.object-list-row'));
      rows2[0].querySelector('.object-list-eye').click();
      rows2[1].querySelector('.object-list-eye').click();
      await new Promise((s) => setTimeout(s, 200));
      R.lastOneLeft = r.drawnObjects().length;
      r.setShownObjects(names);
      r.render('both again');
      await new Promise((s) => setTimeout(s, 200));

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
    print(f"  list: rows {R.get('rows')}, current row {R.get('currentRow')},"
          f" marked row is the current object: {R.get('currentMarked')},"
          f" hidden rows {R.get('hiddenRows')};"
          f" after the eye {R.get('afterEyeInk')} ink"
          f" (merge {R.get('afterEyeMulti')}),"
          f" hiding everything leaves {R.get('lastOneLeft')}")
    print(f"  gpu:   {R['gpuInk']:8d} ink (path taken: {R['gpuTook']})"
          + (f"  DECLINED: {R['gpuError']}" if R.get("gpuError") else ""))

    bad = []
    if not R["multi"]:
        bad.append("the merge did not switch on")
    if R["mapLen"] != R["bothN"]:
        bad.append("the source map does not cover every position")
    if R["crossing"]:
        bad.append(f"{R['crossing']} segments join two objects")
    if R["bothInk"] <= R["oneInk"]:
        bad.append("showing the second object did not add ink")
    if len(set(R["colors"].values())) < len(R["colors"]):
        bad.append("two objects came out the same colour")
    if len(R.get("painted", {})) < len(R["sources"]):
        bad.append("the drawing used fewer colours than there are objects")
    if R["hiddenOnFirst"]:
        bad.append("hiding the second object's backbone wrote onto the first")
    if R["hiddenLocal"] != 0:
        bad.append("the second object's set is not in its own numbering")
    if R["hiddenInk"] >= R["bothInk"]:
        bad.append("hiding 40 residues did not remove any ink")
    if abs(R["restoredInk"] - R["bothInk"]) > 0.02 * R["bothInk"]:
        bad.append("unhiding did not restore the picture")
    if R.get("rows") != R["objects"]:
        bad.append("the list does not name every object")
    if not R.get("currentMarked"):
        bad.append("the marked row is not the current object")
    if R.get("hiddenRows") != 1:
        bad.append("the list does not mark the object that is not drawn")
    if not R.get("afterEyeMulti"):
        bad.append("the eye did not switch the merge on")
    if R.get("afterEyeInk", 0) <= R["oneInk"]:
        bad.append("the eye added no ink")
    if R.get("lastOneLeft") != 1:
        bad.append("the last visible object could be hidden")
    if R.get("sharedColors"):
        bad.append(f"two objects share colours {R['sharedColors']}")
    if R["gpuInk"] <= 0:
        bad.append("the GPU path drew nothing")
    if abs(R["gpuInk"] - R["bothInk"]) > 0.15 * R["bothInk"]:
        bad.append("the GPU picture is not the CPU one")
    for m in bad:
        print("FAIL:", m)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
