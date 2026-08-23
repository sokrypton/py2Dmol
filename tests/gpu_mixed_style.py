"""Two objects, two styles, one picture - and the depth buffer decides.

    python3 tests/gpu_mixed_style.py                 # 1TIM (tube) + 1UBQ (cartoon)
    python3 tests/gpu_mixed_style.py 4UG0.cif 6MRR.cif

The style belongs to the object: a ribosome is a tangle as a ribbon whatever it
is standing next to, and the peptide beside it is not. On the GPU the two
painters write into the same framebuffer with the same depth buffer, so a mixed
picture needs no sorting at all - whoever is nearer wins, per pixel.

What this checks:

  * both halves actually draw, and the mixed picture contains what each of them
    draws on its own (the union, minus what legitimately hides behind);
  * and THE DEPTH ORDER IS REAL. The two objects are separated along the view
    axis, so one is in front; where they overlap on screen, the mixed picture
    must show the FRONT one. Then the view is turned 180 degrees, which swaps
    which is in front, and the overlap must show the other one. A composite
    that simply painted one style over the other passes the first half of that
    and fails the second.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_mixedstyle.html")
FILES = sys.argv[1:] or ["1TIM.cif", "1UBQ.cif"]

JS = """
<script>
window.addEventListener('load', () => {
  const P = new URLSearchParams(location.search);
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  // FRAMES AND ANSWERS, NOT MILLISECONDS. Each step here is a call and a
  // render, and what has to happen before the next line reads the result is
  // that the browser has painted: three animation frames say that in 50 ms
  // where a flat 1,500 said it in 1,500. Where the work is ASYNCHRONOUS - a
  // file parsed, a session restored - the probe waits for the answer instead,
  // which is both faster and steadier than guessing a duration.
  const settle = async (n = 3) => {
    for (let k = 0; k < n; k++) {
      await new Promise((s) => requestAnimationFrame(() => s()));
    }
  };
  const until = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (cond()) return true;
      await settle();
    }
    return false;
  };
  const loaded = () => {
    const v = window.py2dmol_viewers && window.py2dmol_viewers['standalone-viewer-1'];
    return !!(v && v.renderer && v.renderer.coords && v.renderer.coords.length);
  };
  const go = async () => {
    const R = {};
    try {
      for (const f of P.get('files').split(',')) { await load(f); await until(loaded); await settle(); }
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = true;
      // SHADOWS OFF FOR EVERY LEG. The tube's occlusion renders into a
      // framebuffer of its own and is switched off in a composed frame (it
      // would wipe the other painter - see drawTube), so a tube drawn ALONE
      // with occlusion is a different colour everywhere and cannot be compared
      // with the same tube inside a mixed picture. Measured before this line
      // existed: the tube agreed with itself on 0.1% of the overlap.
      r.shadowEnabled = false;

      const names = Object.keys(r.objectsData);
      R.names = names;
      const pix = () => {
        const c = r.canvas;
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      };
      const isInk = (d, i) => (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235);
      const count = (d) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (isInk(d, i)) n++; return n; };

      // SEPARATED ALONG THE VIEW AXIS, by hand: two files loaded together sit
      // wherever their coordinates put them, which may be nowhere near each
      // other in depth. Pushing one 60 A along z makes the depth order a fact
      // rather than a hope - and turning the view 180 degrees reverses it.
      // THE VIEW IS THE MODEL'S OWN AXES for this test. Two things otherwise
      // stand between "shifted along z" and "in front": the object's stored
      // best-view matrix, which is applied before the user's rotation and
      // differs per object, and whatever rotation the viewer opened with. With
      // both set to identity, +z is toward or away from the eye and a half
      // turn about y reverses it - which is the whole basis of the check.
      // Without this the two objects sometimes separated across the SCREEN
      // instead of in depth, and the answer changed from run to run.
      r.viewerState.rotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (const nm of names) r.objectsData[nm].rotation_matrix = null;
      const shift = (nm, dz) => {
        const o = r.objectsData[nm];
        for (const fr of o.frames) for (const p of fr.coords) p.z += dz;
        o.center = null;
      };
      // FAR ENOUGH APART TO SETTLE IT. 60 A was not: the two structures'
      // own radii are 38 and 16, so they still interpenetrated and each won
      // some of the overlapping pixels - correctly, and uselessly as a test
      // (the front object scored 0.43 to 0.64 from run to run). Separated by
      // more than the sum of their radii, whoever is in front is in front of
      // ALL of it.
      const rad = (nm) => (r.objectsData[nm].maxExtent || 30);
      const gap = rad(names[0]) + rad(names[1]) + 40;
      shift(names[0], -gap);
      shift(names[1], gap);
      r.setShownObjects(names); await settle();
      // THE CAMERA IS PINNED for every leg. Showing one object at a time
      // otherwise re-centres on it - the view centre falls back to the drawn
      // object's own centroid - and the alone pictures would then be of a
      // different camera than the mixed one, which makes comparing them
      // meaningless (measured: nothing agreed with anything).
      const st = r.drawnStats();
      r.viewerState.center = { x: st.center[0], y: st.center[1], z: st.center[2] };
      r.viewerState.extent = st.maxExtent;
      const pin = () => {
        r.viewerState.center = { x: st.center[0], y: st.center[1], z: st.center[2] };
        r.viewerState.extent = st.maxExtent;
      };
      r.setStyleForObject(names[0], 'tube');
      r.setStyleForObject(names[1], 'cartoon');
      r.render('mixed'); await settle();
      R.groups = Array.from(r.drawnStyleGroups().keys()).sort();
      R.halves = window.__mixedFrame;
      R.gpu = r.gpuDrewLastFrame;
      const mixed = pix();
      R.mixedInk = count(mixed);

      // each alone, in the style it has in the mixed picture
      r.setShownObjects([names[0]]); pin(); r.render('tube alone'); await settle();
      const tube = pix();
      r.setShownObjects([names[1]]); pin(); r.render('cartoon alone'); await settle();
      const cart = pix();
      R.tubeInk = count(tube);
      R.cartoonInk = count(cart);
      let missing = 0, overlap = 0;
      for (let i = 0; i < mixed.length; i += 4) {
        const it = isInk(tube, i), ic = isInk(cart, i);
        if ((it || ic) && !isInk(mixed, i)) missing++;
        if (it && ic) overlap++;
      }
      R.union = {missing, overlap};

      // WHO IS IN FRONT, where they overlap. names[1] was pushed +60 in z;
      // the renderer's z runs INTO the screen or out of it depending on the
      // rotation, so the answer is not assumed - it is read off which of the
      // two alone-pictures the mixed one agrees with, and then checked to
      // REVERSE when the view turns 180 degrees.
      // WHO WON EACH OVERLAPPING PIXEL, by comparing with each object drawn
      // ALONE - the same style, the same settings, the same camera, so the
      // front object's pixels are exactly its own.
      //
      // NOT BY COLOUR, which is what this tried first: two objects auto-
      // coloured green ([100,252,100] and [188,236,172]) are not separable by
      // nearest hue, and the answer came out 0.44 to 0.38 - noise.
      // ...OVER THE INTERIORS, not the edges. An outline is drawn over
      // whatever is behind it and takes some of that colour with it, so the
      // same outline over paper and over a tube are different pixels -
      // correctly - and a ribbon has gaps between its strands that the object
      // behind shows through. Both are edge effects, and both are why the
      // front object scored 0.62 and looked like a failure. Eroding each
      // picture by two pixels leaves the parts that are solidly one object.
      const W = r.canvas.width;
      const erode = (d) => {
        let m = new Uint8Array(d.length / 4);
        for (let i = 0, k = 0; i < d.length; i += 4, k++) m[k] = isInk(d, i) ? 1 : 0;
        for (let pass = 0; pass < 2; pass++) {
          const n2 = new Uint8Array(m.length);
          for (let k = 0; k < m.length; k++) {
            if (!m[k]) continue;
            const x = k % W;
            n2[k] = (m[k - 1] && m[k + 1] && m[k - W] && m[k + W]
              && x > 0 && x < W - 1) ? 1 : 0;
          }
          m = n2;
        }
        return m;
      };
      const wonBy = (mix, A, B) => {
        const ea = erode(A), eb = erode(B);
        let a = 0, b = 0, seen = 0;
        const near = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1])
          + Math.abs(p[i + 2] - q[i + 2]) < 24;
        for (let i = 0, k = 0; i < mix.length; i += 4, k++) {
          if (!(ea[k] && eb[k])) continue;
          seen++;
          const inA = near(mix, A, i), inB = near(mix, B, i);
          if (inA && !inB) a++; else if (inB && !inA) b++;
        }
        return { tube: seen ? a / seen : 0, cartoon: seen ? b / seen : 0, seen };
      };
      R.front = wonBy(mixed, tube, cart);

      // ...and now turn the model over, which swaps which one is nearer
      const turn = () => {
        const R0 = r.viewerState.rotation;
        // 180 degrees about y: (x, z) -> (-x, -z)
        const flip = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
        const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          let v = 0;
          for (let k = 0; k < 3; k++) v += flip[i][k] * R0[k][j];
          out[i][j] = v;
        }
        r.viewerState.rotation = out;
      };
      turn();
      r.setShownObjects([names[0]]); pin(); r.render('tube alone, turned'); await settle();
      const tube2 = pix();
      r.setShownObjects([names[1]]); pin(); r.render('cartoon alone, turned'); await settle();
      const cart2 = pix();
      r.setShownObjects(names); pin(); r.render('mixed, turned'); await settle();
      const mixed2 = pix();
      let ov2 = 0;
      for (let i = 0; i < mixed2.length; i += 4) {
        if (isInk(tube2, i) && isInk(cart2, i)) ov2++;
      }
      const w2 = wonBy(mixed2, tube2, cart2);
      R.turned = {tube: w2.tube, cartoon: w2.cartoon, seen: w2.seen,
                  halves: window.__mixedFrame, overlap: ov2,
                  inkTube: count(tube2), inkCartoon: count(cart2), inkMixed: count(mixed2)};
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
src = open(os.path.join(ROOT, "index.html")).read()
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9773), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-mixedstyle",
                      "--no-first-run", "--window-size=900,900",
                      "http://127.0.0.1:9773/_mixedstyle.html?files=" + ",".join(FILES)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 400
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-mixedstyle", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

h = R.get("halves") or {}
print(f"{'+'.join(FILES)}: styles {R.get('groups')}, GPU {R.get('gpu')},"
      f" halves drew cartoon={h.get('cartoon')} tube={h.get('tube')}"
      f" ({h.get('nCartoon')} + {h.get('nTube')} positions)")
print(f"  ink: tube alone {R.get('tubeInk')}, cartoon alone {R.get('cartoonInk')},"
      f" mixed {R.get('mixedInk')}; missing from the mixed picture"
      f" {(R.get('union') or {}).get('missing')}, overlapping"
      f" {(R.get('union') or {}).get('overlap')}")
f1, f2 = R.get("front") or {}, R.get("turned") or {}
print(f"  turned: overlap {f2.get('overlap')}, ink tube {f2.get('inkTube')},"
      f" cartoon {f2.get('inkCartoon')}, mixed {f2.get('inkMixed')}")
print(f"  in the overlap, the mixed picture agrees with:"
      f" tube {f1.get('tube'):.2f} / cartoon {f1.get('cartoon'):.2f}"
      f"  -> turned 180: tube {f2.get('tube'):.2f} / cartoon {f2.get('cartoon'):.2f}")
bad = []
if not R.get("gpu") or not h.get("cartoon") or not h.get("tube"):
    bad.append("one of the two painters did not draw: " + str(h))
ov = (R.get("union") or {}).get("overlap") or 0
if ov < 500:
    bad.append(f"the two objects barely overlap on screen ({ov} px), so the"
               " depth check below proves nothing - move them closer")
# WHICHEVER IS IN FRONT WINS THE OVERLAP, and turning the model over hands the
# overlap to the other one. That flip is the whole assertion: a composite that
# painted one style over the other passes the first half and fails the second.
#
# THE MARGINS ARE NOT SYMMETRIC, and the pictures say why. A tube in front is
# solid, and it takes 0.93-0.98 of the overlap. A RIBBON in front is not: it
# has gaps between its strands that the tube behind shows through, and an
# outline that blends with whatever it is drawn over, so it takes 0.6-0.7 with
# the rest going to the object behind - correctly. Eroding both silhouettes by
# two pixels removes the halo but not the holes.
first = "tube" if (f1.get("tube", 0) > f1.get("cartoon", 0)) else "cartoon"
second = "tube" if (f2.get("tube", 0) > f2.get("cartoon", 0)) else "cartoon"
if first == second:
    bad.append(f"turning the model over did not change which object is in"
               f" front ({first} both times): the styles are being painted in"
               " a fixed order rather than sorted by depth")
if f1.get(first, 0) < 0.55 or f1.get(first, 0) < 2 * f1.get(second, 1):
    bad.append(f"nothing clearly wins the overlap before the turn: {f1}")
if f2.get(second, 0) < 0.85:
    bad.append(f"the solid object does not own the overlap when it is in"
               f" front: {f2}")
for b in bad:
    print("FAIL: " + b)
sys.exit(1 if bad else 0)
