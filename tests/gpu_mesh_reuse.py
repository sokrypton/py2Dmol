"""Switching an object off and on again reuses its mesh instead of rebuilding.

    python3 tests/gpu_mesh_reuse.py                  # 6MRR + 4HHB
    python3 tests/gpu_mesh_reuse.py 4UG0.cif 6MRR.cif

A cartoon mesh is built for exactly what is on screen, so an eye toggle asks
for a different one - and the build runs the whole 2D pass and the outline
pass again. With a ribosome and a peptide up, that is 1.2 s for a change of 68
residues out of 17,618, paid on every toggle, both ways.

Two things were in the way and both are fixed here:

  * the mesh signature keyed the visibility mask by object IDENTITY, and the
    mask is rebuilt from the objects' own records whenever the drawn set
    changes - so an identical picture never matched. It is keyed by CONTENT
    now, cached against the Set;
  * and the mesh that was being replaced was thrown away. One spare slot holds
    it, and coming back is two uploads. It is an EXCHANGE: alternating is what
    an eye is for, so the outgoing mesh takes the incoming one's place.

What this checks: that the toggle stops rebuilding, that it gets faster, and -
the part that matters - that the restored picture is IDENTICAL to the one a
fresh build draws, with picking still landing on the same residue. A mesh
restored without the positions it was captured with would look perfect and put
every click in the wrong place.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_meshreuse.html")
# THE SMALL ONE FIRST, deliberately. Several of the things a mesh carries are
# sized by the structure and SHRINK - the visibility texture among them - so a
# restore that forgets one only shows when the mesh coming back is BIGGER than
# the one before it. The other order passes either way.
FILES = sys.argv[1:] or ["6MRR.cif", "4HHB.cif"]

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {toggles: []};
    try {
      const P = new URLSearchParams(location.search);
      for (const f of P.get('files').split(',')) { await load(f); await until(loaded); await settle(); }
      await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = true;
      r.styleChosen = true;            // a cartoon, because the user asked for one
      r.setStyle('cartoon');
      await settle();
      R.n = r.coords.length;
      R.gpuDrew = r.gpuDrewLastFrame;
      const names = Object.keys(r.objectsData);

      const shot = () => r.canvas.toDataURL('image/png');
      const pick = () => {
        // ...the same three points, which is what a click has to keep hitting
        r._ensurePickProjection();
        const rect = r.canvas.getBoundingClientRect();
        const out = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.6], [0.6, 0.45]]) {
          out.push(r.pickResidueAt(rect.left + rect.width * fx,
                                   rect.top + rect.height * fy));
        }
        return out.join(',');
      };
      const rebuiltAt = () => (window.__rebuild ? window.__rebuild.t0 : 0);

      // THE PICKER FIRST, one object at a time - and BEFORE the merge leg,
      // because a merge leaves the visibility texture sized for both objects
      // at once, which is big enough for either of them alone and hides the
      // very fault this leg is here to catch.
      //
      // ...the other way of asking for a different mesh: the picker, one
      // object at a time. This is the case the toggles above do not cover, and
      // it is where the first version of the spare slot broke - the visibility
      // texture is sized per structure and SHRINKS, so a mesh restored after a
      // smaller one had every residue past the smaller one's end read as
      // hidden. Its fills vanished and its outline stayed.
      //
      // The reference is taken at the END, from forced rebuilds. Taking it
      // between the switches would throw the kept mesh away and the restore
      // would never run - which is how the first probe missed this.
      const sel = document.getElementById('objectSelect');
      const to = async (nm) => {
        sel.value = nm; sel.dispatchEvent(new Event('change'));
        await settle();
      };
      const seen = [];
      for (let k = 0; k < 4; k++) {
        const nm = names[k % 2];
        await to(nm);
        seen.push({name: nm, png: shot(), pick: pick()});
      }
      const ref = {};
      for (const nm of names) {
        await to(nm);
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild'); await settle();
        ref[nm] = {png: shot(), pick: pick()};
      }
      R.switches = seen.map((x) => ({
        name: x.name, same: x.png === ref[x.name].png,
        pickSame: x.pick === ref[x.name].pick,
      }));

      const both = [names[0], names[1]];
      // THE SECOND OBJECT ALONE, not the first. Hiding the LAST object leaves
      // the others' positions where they were, so a mesh restored without the
      // positions it was captured with still picks correctly by accident.
      // Hiding the FIRST shifts everything after it, and a stale position
      // array then puts every click on the wrong residue.
      const one = [names[1]];
      // ONE FULL CYCLE FIRST, so the camera has stopped moving: the very first
      // time an object is drawn the view widens to take it in, and a reference
      // shot taken then is of a different camera, not a different mesh.
      r.setShownObjects(both); await settle();
      r.setShownObjects(one); await settle();
      // THE REFERENCE IS A FRESH BUILD, forced. Taken after a restore instead,
      // it is the restore's own answer - so a restore that came back missing
      // something would be compared against itself and agree. This is the
      // check the whole probe exists for.
      const freshShot = async (want) => {
        r.setShownObjects(want); await settle();
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild'); await settle();
        return {png: shot(), pick: pick()};
      };
      const bothFresh = await freshShot(both);
      const oneFresh = await freshShot(one);
      // ...and the FIRST of these builds is the one that pays, because the
      // slot holds one mesh and this asks for the other
      let t0 = rebuiltAt();
      R.firstMs = null;

      for (let k = 0; k < 4; k++) {
        const want = k % 2 === 0 ? both : one;
        t0 = rebuiltAt();
        const t = performance.now();
        r.setShownObjects(want);        // synchronous: the build is in here
        const ms = performance.now() - t;
        await settle();
        const ref = k % 2 === 0 ? bothFresh : oneFresh;
        R.toggles.push({
          shown: want.length, ms: Math.round(ms),
          rebuilt: rebuiltAt() !== t0,
          same: shot() === ref.png,
          pickSame: pick() === ref.pick,
          pick: pick(),
        });
      }
      R.spare = window.__spareMesh ? window.__spareMesh.bytes : null;

      // MOVED GEOMETRY, SAME STATEMENT ABOUT IT. An alignment shifts
      // coordinates without changing which objects are drawn, which frame each
      // shows, or how many positions there are - every term the key is built
      // from except the content probe. Half the positions move here so the
      // SHAPE changes and not just the centre, which the camera would undo.
      {
        const before = shot();
        const t0m = rebuiltAt();
        const co = r.coords || [];
        for (let i = 0; i < (co.length >> 1); i++) co[i].x += 8;
        r.render('moved'); await settle();
        R.moved = {rebuilt: rebuiltAt() !== t0m, changed: shot() !== before};
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9755), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-meshreuse",
                      "--no-first-run", "--window-size=900,900",
                      "http://127.0.0.1:9755/_meshreuse.html?files=" + ",".join(FILES)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-meshreuse", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{'+'.join(FILES)}: {R.get('n')} positions, GPU drew: {R.get('gpuDrew')},"
      f" spare mesh {round((R.get('spare') or 0) / 1e6, 1)} MB")
bad = []
if not R.get("gpuDrew"):
    bad.append("the GPU path did not draw, so nothing here was measured")
for i, t in enumerate(R["toggles"]):
    print(f"  toggle {i + 1}: {t['shown']} object(s), {t['ms']:>5} ms,"
          f" rebuilt={t['rebuilt']}, same picture={t['same']},"
          f" same picks={t['pickSame']} ({t['pick']})")
    if not t['same']:
        bad.append(f"toggle {i + 1}: the picture differs from a fresh build")
    if not t['pickSame']:
        bad.append(f"toggle {i + 1}: picking moved - the mesh came back without"
                   " the positions it was captured with")
# ...the first toggle may still build (the second mesh has never existed); every
# one after it must come out of the slot
# the first two toggles build the two meshes (the references were taken from
# forced rebuilds, which throw the spare away); every one after that must come
# out of the slot
later = R["toggles"][2:]
mv = R.get("moved") or {}
print(f"  coordinates moved in place: rebuilt={mv.get('rebuilt')},"
      f" picture changed={mv.get('changed')}")
if not mv.get("rebuilt") or not mv.get("changed"):
    bad.append("moving the coordinates without changing which objects or frames"
               " are drawn left the old mesh on screen: " + str(mv))

if any(t['rebuilt'] for t in later):
    bad.append("a toggle back to a mesh already built rebuilt it anyway: "
               + str([t['rebuilt'] for t in R["toggles"]]))
if later and max(t['ms'] for t in later) > 0.5 * max(1, R["toggles"][0]['ms']):
    bad.append(f"the reused toggles are not faster than the builds:"
               f" {[t['ms'] for t in R['toggles']]}")
for i, sw in enumerate(R.get("switches") or []):
    print(f"  switch {i + 1}: to {sw['name']}, same picture={sw['same']},"
          f" same picks={sw['pickSame']}")
    if not sw['same']:
        bad.append(f"switch {i + 1} to {sw['name']}: the picture differs from a"
                   " fresh build - a mesh came back with something the build"
                   " sets and the restore does not")
    if not sw['pickSame']:
        bad.append(f"switch {i + 1} to {sw['name']}: picking moved")
if not R.get("switches"):
    bad.append("the picker leg did not run")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
