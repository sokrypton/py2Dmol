"""A colour change repaints the GPU mesh; it does not rebuild it.

    python3 tests/gpu_recolour.py            # 1EHZ, a small RNA
    python3 tests/gpu_recolour.py 4UG0.cif   # a ribosome

The cartoon's GPU mesh carries a palette INDEX per face, so changing the colour
scheme is three texels per segment against geometry that never moves. A face
whose colour did not come from the palette has to bake it instead - and one
baked face makes the whole mesh ineligible, because there is no way to repaint
it from a new palette.

Nucleic BASE RUNGS were baked: their colour is `colors[bbSeg[i]]`, a palette
lookup like any other, but the index was not recorded. So every colour change
on any structure with a base pair in it rebuilt the entire mesh - 21,744 of
167,824 faces on 4UG0, and 950 ms against the 30 ms an upload costs.

What this checks:

  * no face is baked, so the cheap path is available at all;
  * a colour change does not rebuild the mesh, and is fast;
  * THE PICTURE IS THE SAME as the one a full rebuild draws - pixel for pixel,
    in each mode, which is what catches a rung repainted from the wrong slot;
  * and the cases that MUST rebuild still do: ss mode cuts geometry at the
    midpoint between two colours, and a per-residue override does the same.
"""
import base64, http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_recolour.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1EHZ.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {modes: []};
    try {
      await load(new URLSearchParams(location.search).get('f')); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = true;
      r.styleChosen = true;
      r.setStyle('cartoon');
      await settle();
      R.n = r.coords.length;
      R.gpuDrew = r.gpuDrewLastFrame;
      const sel = document.getElementById('colorSelect');
      const setMode = async (m) => {
        sel.value = m; sel.dispatchEvent(new Event('change'));
        await settle();
      };
      const shot = () => r.canvas.toDataURL('image/png');
      const rebuiltAt = () => (window.__rebuild ? window.__rebuild.t0 : 0);

      for (const mode of ['chain', 'rainbow', 'plddt', 'auto']) {
        // ...the cheap way: whatever mesh is up, repainted
        let t0 = rebuiltAt();
        const t = performance.now();
        await setMode(mode);
        const ms = performance.now() - t;
        const rebuilt = rebuiltAt() !== t0;
        const cheap = shot();
        // ...and the same mode from a mesh built for it
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild');
        await settle();
        const fresh = shot();
        R.modes.push({mode, ms: Math.round(ms), rebuilt, same: cheap === fresh,
                      pal: window.__palComplete});
      }

      // A REPAINT AFTER A SIDE CHAIN, which is the one case where the two
      // mechanisms meet. The ribbon half of the mesh is REUSED across a
      // side-chain change, and a face carries both its baked colour and the
      // palette slot to repaint it from - and the slot is the one thing a side
      // chain moves, because it indexes the segment list and a side-chain bond
      // is a segment. Two faces of 8,514 on 4HHB. Reusing the half without
      // putting those back leaves them repainting from a neighbouring
      // residue's colour, or off the end of a shorter palette - which is
      // invisible until something changes the palette without rebuilding,
      // exactly what these four modes do.
      await setMode('auto');
      {
        const want = [4, 5, 6, 7, 8];
        for (const g of r.writeGroups(want)) {
          if (!g.object) continue;
          const cur = g.object.sidechains instanceof Set
            ? new Set(g.object.sidechains) : new Set();
          for (const i of g.positions) cur.add(i);
          g.object.sidechains = cur;
        }
        r._invalidateSegmentCache();
        r.reloadDrawn(); await settle();
        await setMode('rainbow');           // repaint, no rebuild
        const cheap = shot();
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild'); await settle();
        R.afterSidechains = {same: cheap === shot(), table: !!r.sidechains};
        await setMode('auto');
        for (const g of r.writeGroups(want)) if (g.object) g.object.sidechains = null;
        r._invalidateSegmentCache();
        r.reloadDrawn(); await settle();
      }

      // ...AND ss, WHICH REPAINTS LIKE THE REST. It reads as though it should
      // not: the colour is not colors[segIdx], it is ssPal[ssCls]. But ss
      // resolves ONE colour per interval - both ends take the same class - so
      // col === colFar, no interval is cut, and the geometry is identical
      // (1019 mesh faces in chain, rainbow and ss alike). What used to force a
      // rebuild was that the ss colour was computed INSIDE the draw pass, so a
      // repaint had nothing to upload; resolveSegmentColors answers it from the
      // assignment, the palette and each segment's two residues instead.
      //
      // The picture is what is asserted, not the rebuild: a repaint that draws
      // the wrong thing is the failure worth catching, and a repaint that draws
      // the right thing is the point.
      // the probe's own comparison, as used for the modes above: repaint,
      // then force a rebuild of the same state and diff the two frames
      const sameAsRebuild = async () => {
        const cheap = shot();
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild');
        await settle();
        return cheap === shot();
      };
      let t0 = rebuiltAt();
      await setMode('ss');
      R.ssRebuilt = rebuiltAt() !== t0;
      R.ssSame = await sameAsRebuild();
      await setMode('auto');
      R.leftSsSame = await sameAsRebuild();
      t0 = rebuiltAt();
      const o = r.objectsData[r.currentObjectName];
      o.color = {type: 'advanced', value: {position: {3: '#ff0000'}}};
      r._invalidateSegmentCache();
      r.render('override');
      await settle();
      R.overrideRebuilt = rebuiltAt() !== t0;
      R.overrideShot = shot();
      window.py2dmolCartoonGPU.invalidate();
      r.render('forced rebuild');
      await settle();
      R.overrideSame = R.overrideShot === shot();

      // 🔴 AND A COLOUR CHANGE THE STATION FAST PATH CARRIES, which is the one
      // this probe did not reach. Every case above changes the colour MODE on
      // a still structure; a TRAJECTORY changes the colours by stepping, and
      // the station path answers that step - it rewrites POSITIONS from the
      // station table and never touches the palette. It used to record
      // `appColourKey = colourKeyOf(colors)` all the same, which tells the
      // upload branch the colours are already on the card, so a frame whose
      // pLDDT differed kept the colours of the last real BUILD, permanently.
      //
      // The fixture is the shape an AlphaFold 3 fold has: frames the sampler
      // wrote before the confidence head ran, which carry a ZERO pLDDT on
      // purpose, and a finished frame carrying the real one. Stepping between
      // the last two is a colour change over a mesh that holds still, and the
      // two must not paint the same.
      const N = r.coords.length;
      // ...taken BEFORE addObject, which makes the new object the current one:
      // read inside the closure it was the empty object's, and `frames[0]` of
      // an object with no frames is undefined.
      const srcCoords = r.objectsData[r.currentObjectName].frames[0].coords;
      const flat = (v) => ({coords: srcCoords, plddts: Array(N).fill(v)});
      r.addObject('station');
      r.setShownObjects(['station'], false, {reframe: true});
      for (let k = 0; k < 8; k++) r.addFrame(flat(0), 'station');
      r.addFrame(flat(85), 'station');
      await setMode('plddt');
      const frames = r.objectsData.station.frames.length;
      // ...warmed, so the mesh is RESIDENT and the step below is the station
      // path rather than the build that makes it
      r.setFrame(frames - 1); r.render('station warm'); await settle(4);
      const onLast = shot();
      r.setFrame(frames - 2); r.render('station step'); await settle(4);
      const onPrev = shot();
      window.py2dmolCartoonGPU.invalidate();
      r.render('station rebuild'); await settle(4);
      // 🔴 COUNTED, NOT COMPARED BYTE FOR BYTE. The first version of this leg
      // asked `onPrev === shot()`, which held when it was written and broke the
      // moment sticks were given stations: the two paths lay their rows out
      // differently, so where a stick surface and the ribbon it grows from land
      // on the same depth the pixel goes to whichever was drawn first. Measured
      // 13 of 722,500 at a worst channel of 67 - the same tie-break class as
      // the three-part mesh split (260 of 357,604) and the dropped depth sort
      // (2,401 of 498,436), both of which this project accepts by name.
      //
      // An exact comparison here reports that noise as a colour fault, which is
      // what it did: the probe failed while `stepped` was true and the ramp was
      // following the frame perfectly. The bound is what the noise is, with
      // room - a real palette miss is EVERY inked pixel of the structure, four
      // orders of magnitude away, so nothing is being let through.
      const diffPixels = await (async () => {
        const load = (u) => new Promise((res) => {
          const c = document.createElement('canvas');
          c.width = r.canvas.width; c.height = r.canvas.height;
          const g = c.getContext('2d'); const im = new Image();
          im.onload = () => { g.drawImage(im, 0, 0);
            res(g.getImageData(0, 0, c.width, c.height).data); };
          im.src = u;
        });
        const [a, b] = await Promise.all([load(onPrev), load(shot())]);
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          let d = 0;
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
          if (d > 2) n += 1;
        }
        return {n, total: a.length / 4};
      })();
      R.station = {
        frames,
        // the step must change the picture...
        stepped: onLast !== onPrev,
        // ...and land where a rebuild of the same frame lands, bar the ties
        diff: diffPixels.n, totalPx: diffPixels.total,
        fast: window.__stationFastPath || 0,
      };
      // 🔴 AND THE REPAINT'S OWN RESOLVER MUST AGREE WITH THE RENDERER
      // ABOUT WHICH POSITION A SEGMENT TAKES ITS COLOUR FROM. `colors` is
      // what the 2D painter draws from and `resolveSegmentColors` is what
      // fills the palette texture, so where the two disagree the two
      // painters draw one bond in two colours. The bond it happens on is the
      // CA-CB: its idx1 is the BACKBONE alpha carbon and the renderer
      // resolves it through the SIDE-CHAIN end (_colorSegmentPosition), so
      // an override read at idx1 hands the main chain's colour to the first
      // stick of every side chain. Reported as: colour the side chains
      // yellow, colour the backbone red, and the CA-CB bond goes red.
      {
        // ...on a PROTEIN, because this probe's own fixture is RNA and a
        // nucleotide has no side chain to attach. Loaded here rather than at
        // the top so every leg above still measures what it was written for.
        await load('1UBQ.cif');
        await until(loaded);
        await settle(4);
        const all = Array.from({length: r._baseCount ? r._baseCount() : r.coords.length},
          (u, i) => i);
        r.setResidueSelection(new Set(all));
        await settle(2);
        r.showSidechains({positions: all});
        await settle(4);
        r.setSidechainColor('#ffff00', {positions: all});
        // ...the main chain forced to another colour, in the shape the
        // selection panel writes (parts/selectpanel.js: setSelectionColor).
        const obj = r.objectsData[r.currentObjectName];
        const pos = {};
        for (const i of all) pos[i] = '#ff0000';
        obj.color = {type: 'advanced', value: {position: pos}};
        r.colorsNeedUpdate = true; r.plddtColorsNeedUpdate = true;
        r.reloadDrawn(true);
        await settle(6);
        const cols = r._calculateSegmentColors();
        const C = window.py2dmolCartoon;
        const live = C && C.resolveSegmentColors
          ? C.resolveSegmentColors(r, cols) : null;
        const hex = (c) => c ? [c.r | 0, c.g | 0, c.b | 0].join(',') : 'none';
        let seen = 0, differ = 0, sample = null;
        (r.segmentIndices || []).forEach((seg, k) => {
          if (!seg || !r.sidechainMap) return;
          const one = r.sidechainMap.has(seg.idx1) !== r.sidechainMap.has(seg.idx2);
          if (!one) return;                 // the CA-CB bonds, and only those
          seen += 1;
          if (!live) return;
          if (hex(live[k]) !== hex(cols[k])) {
            differ += 1;
            if (!sample) sample = {k, painter: hex(cols[k]), palette: hex(live[k])};
          }
        });
        R.attach = {seen, differ, sample, resolved: !!live,
                    sidechain: hex(r.getAtomColor([...r.sidechainMap.keys()][0])),
                    backbone: hex(r.getAtomColor(0))};
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
src = open(os.path.join(ROOT, "dev.html")).read()
stamp = str(int(time.time() * 1000))
src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
             lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
open(PROBE, "w").write(src.replace("</body>", JS + "</body>"))
box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9751), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-recolour",
                      "--no-first-run", "--window-size=900,900",
                      f"http://127.0.0.1:9751/_recolour.html?f={FILE}"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-recolour", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{FILE}: {R.get('n')} positions, drawn on the GPU: {R.get('gpuDrew')}")
bad = []
st = R.get("station") or {}
print(f"  station path: {st.get('frames')} frames, stepped={st.get('stepped')},"
      f" {st.get('diff')} of {st.get('totalPx')} pixels differ from a rebuild,"
      f" fastPaths={st.get('fast')}")
if not st:
    bad.append("the station leg did not run")
else:
    if not st.get("stepped"):
        bad.append("a frame step that changes only the pLDDT drew the SAME"
                   " picture - the station fast path recorded the new colour"
                   " key without uploading the palette, so the card keeps the"
                   " colours of the last rebuild")
    # 0.05% of the canvas: two orders above the tie-break noise measured here
    # (13 of 722,500 = 0.0018%) and two below a palette that did not arrive,
    # which is every inked pixel of the structure.
    cap = max(64, (st.get("totalPx") or 0) // 2000)
    if (st.get("diff") or 0) > cap:
        bad.append(f"the station path drew {st['diff']} of {st['totalPx']}"
                   f" pixels differently from a rebuild of the same frame"
                   f" (more than {cap}) - its colours are not the colours a"
                   " rebuild draws")
if not R.get("gpuDrew"):
    bad.append("the GPU path did not draw, so nothing here was measured")
for m in R["modes"]:
    print(f"  {m['mode']:8s} {m['ms']:>5} ms  rebuilt={m['rebuilt']}"
          f"  identical to a rebuild={m['same']}  palette complete={m['pal']}")
    if not m['pal']:
        bad.append(f"{m['mode']}: the mesh has baked faces, so no colour change"
                   " can be an upload")
    if m['rebuilt']:
        bad.append(f"{m['mode']}: the colour change rebuilt the mesh")
    if not m['same']:
        bad.append(f"{m['mode']}: the repainted picture differs from the one a"
                   " rebuild draws - a face is reading the wrong palette slot")
asc = R.get("afterSidechains") or {}
print(f"  repaint after a side chain: matches a rebuild={asc.get('same')}"
      f" (side-chain table: {asc.get('table')})")
if not asc:
    bad.append("the side-chain leg did not run")
elif not asc.get("table"):
    bad.append("this structure carries no side-chain table, so the repaint"
               " after a side chain measured nothing")
elif not asc.get("same"):
    bad.append("after showing side chains, a repaint differs from what a"
               " rebuild draws - the reused ribbon half is repainting from"
               " palette slots that the side chain moved")
print(f"  ss mode rebuilt: {R.get('ssRebuilt')} (matches a rebuild:"
      f" {R.get('ssSame')}; leaving it matches: {R.get('leftSsSame')});"
      f" an override rebuilt: {R.get('overrideRebuilt')}"
      f" (and matches a rebuild: {R.get('overrideSame')})")
# 🔴 THE PICTURE, NOT THE REBUILD. ss adds no cut, so it repaints - and what
# has to hold is that the repainted frame is the one a rebuild would draw.
# Both directions: leaving ss repainted from a stale renderer._cartoonPalette
# once and put ss colours on a chain frame, 7.84% of the picture.
if R.get("ssSame") is False:
    bad.append("ss mode repainted a picture a rebuild does not draw")
if R.get("leftSsSame") is False:
    bad.append("leaving ss repainted a picture a rebuild does not draw - the"
               " palette it uploaded is not this mode's")
if not R.get("overrideRebuilt"):
    bad.append("a per-residue override did not rebuild, for the same reason")
if not R.get("overrideSame"):
    bad.append("the override's picture differs from a rebuild's")
at = R.get("attach") or {}
print(f"  CA-CB bonds: {at.get('seen')} seen, {at.get('differ')} coloured"
      f" differently by the palette than by the painter"
      f" (side chain {at.get('sidechain')}, backbone {at.get('backbone')})")
if not at.get("resolved"):
    bad.append("resolveSegmentColors answered null - this leg measured nothing")
elif not at.get("seen"):
    bad.append("no CA-CB bond was found, so the check is empty - the fixture"
               " must have side chains materialised")
elif at.get("differ"):
    bad.append(f"{at['differ']} of {at['seen']} CA-CB bonds take a different"
               f" colour from the palette than from the painter: {at.get('sample')}"
               " - the GPU draws the first stick of every side chain in the"
               " main chain's colour while the 2D painter draws it in the side"
               " chain's")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
