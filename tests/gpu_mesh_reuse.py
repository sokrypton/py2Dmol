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

AND SHOWING A FEW SIDE CHAINS, which is the change the mesh does not yet reuse
anything across: it APPENDS positions, so every term of the key moves and the
whole mesh is rebuilt for 1.8% more faces - 50 ms of it on 4HHB, measured, and
the same 50 ms for one side chain as for ten. That leg is here BEFORE the split
into a ribbon model and a stick model, so the refactor has something to be
verified against from its first commit rather than its last. It asks the three
questions that only mean anything together: that the side chains actually drew,
that the picture equals a forced fresh build of the same state, and that taking
them off again returns to the picture before them.
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

      // SIDE CHAINS APPEND POSITIONS, which is the change the mesh is about to
      // stop rebuilding for. A handful of side chains is 1.8% of the faces and
      // costs a full rebuild today - the split into a ribbon model and a stick
      // model is what changes that, and this leg is what says the picture did
      // not move while it happened.
      //
      // It is written as three questions rather than one, because only the
      // three together mean anything:
      //   * the side chains ACTUALLY DREW - without this the leg passes by
      //     comparing two identical pictures of nothing;
      //   * the picture is what a FORCED FRESH BUILD draws, which is the
      //     assertion a partial rebuild has to keep earning;
      //   * and taking them off again returns to the picture before, so a
      //     ribbon model kept across the change is kept CORRECTLY rather than
      //     kept stale.
      // Picking is asked at every step for the same reason it is asked above:
      // a mesh whose positions are one build behind looks perfect.
      {
        const S = (R.sidechains = {table: !!r.sidechains}); window.__hashBisect = 1;
        r.setShownObjects(one); await settle();
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild'); await settle();
        const bare = {png: shot(), pick: pick()};
        const nBare = r.coords.length;

        const setSC = (on) => {
          const want = [10, 11, 12, 13, 14, 15];
          for (const g of r.writeGroups(want)) {
            if (!g.object) continue;
            const cur = g.object.sidechains instanceof Set
              ? new Set(g.object.sidechains) : new Set();
            for (const i of g.positions) { if (on) cur.add(i); else cur.delete(i); }
            g.object.sidechains = cur.size ? cur : null;
          }
          r._invalidateSegmentCache();
          const t0r = rebuiltAt();
          const t = performance.now();
          r.reloadDrawn();
          r.render('sidechains');
          return {ms: Math.round(performance.now() - t), rebuilt: rebuiltAt() !== t0r,
            reused: !!(window.__rebuild && window.__rebuild.ribbonReused),
            otherReused: !!(window.__rebuild && window.__rebuild.otherReused),
            nSide: window.__rebuild ? window.__rebuild.nSide : null,
            nOther: window.__rebuild ? window.__rebuild.nOther : null,
            hashMs: window.__rebuild ? window.__rebuild.ribbonHash : null,
            ribbonMs: window.__rebuild ? window.__rebuild.ribbonMs : null,
            stickMs: window.__rebuild ? window.__rebuild.stickMs : null,
            totalMs: window.__rebuild ? window.__rebuild.total : null,
            hash: window.__rebuild ? window.__rebuild.hash : null,
            prevHash: window.__rebuild ? window.__rebuild.prevHash : null,
            nRibbon: window.__rebuild ? window.__rebuild.nRibbon : null,
            nStick: window.__rebuild ? window.__rebuild.nStick : null,
            bisect: window.__bisect, palDiff: window.__palDiff};
        };

        const on = setSC(true); await settle();
        S.onMs = on.ms; S.onRebuilt = on.rebuilt; S.on = on;
        S.atoms = r.coords.length - nBare;
        const withSC = {png: shot(), pick: pick()};
        S.drew = withSC.png !== bare.png;

        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild'); await settle();
        S.same = shot() === withSC.png;
        S.pickSame = pick() === withSC.pick;

        const off = setSC(false); await settle();
        S.offMs = off.ms; S.offRebuilt = off.rebuilt; S.off = off;
        S.back = shot() === bare.png;
        S.backPick = pick() === bare.pick;
      }

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

      // 🔴 A REUSED MESH MUST BE DRAWN AT THE FRAMING THE VIEWER WANTS NOW.
      //
      // The mesh carries the extent, centre and SHAPE it was captured under,
      // and the draw divides those out and applies the live ones. The
      // multiplier was `capExtent / liveExtent` alone, on the reasoning that
      // the base scale is padding*size over 2*extent so the extents divide out
      // exactly - true while the fit was isotropic, and false the moment
      // _viewportScale started reading extentAspect. Orient writes a new
      // aspect at the END of its flight, so a viewer with a cached mesh went
      // on drawing at the shape it was captured under.
      //
      // ASKED AS A RATIO, not as a picture: _viewScale is what the GPU drew at
      // and _viewportScale is what the renderer wants, so their quotient is 1
      // when the framing is honoured and nothing else has to be known about
      // the structure. A pixel comparison could not tell "20% too small" from
      // "a different structure".
      {
        const canvas = r.canvas;
        const dpr = window.devicePixelRatio || 1;
        const ratio = () => r._viewScale / r._viewportScale(
          canvas.width / dpr, canvas.height / dpr,
          r.objectsData[r.currentObjectName]);
        const F = (R.framing = {});
        const asp = () => {
          const a = r.viewerState.extentAspect;
          return a ? [+a.x.toFixed(3), +a.y.toFixed(3)] : null;
        };
        const marks = (R.framingMarks = {});
        // 🔴 A WIDE BOX, OR THE CHECK BELOW IS VACUOUS. The wanted scale is
        // `min(w / ax, h / ay)`, and on a canvas that is nearly square the
        // same side wins whatever the aspect is - so a multiplier that ignores
        // the aspect entirely still lands on the right number. dev.html's
        // canvas is square enough for that, and the first version of this test
        // passed against the bug it was written for. Measured on a 560x300
        // box, where the two sides genuinely disagree.
        const holder = document.getElementById('canvasContainer');
        const wasStyle = holder.getAttribute('style') || '';
        holder.style.width = '560px';
        holder.style.height = '300px';
        window.dispatchEvent(new Event('resize'));
        await settle(8);
        marks.canvas = [r.canvas.width, r.canvas.height];
        marks.aspectBefore = asp();
        marks.rebuiltBefore = rebuiltAt();
        F.atRest = ratio();
        // ...a selection with a very different SHAPE from the whole structure,
        // which is what makes the aspect move
        const some = [];
        for (let i = 30; i < 70 && i < r.coords.length; i++) some.push(i);
        window.py2dmolOrient.orientTo(r, {positions: some, animate: false});
        await settle(6);
        F.orientedToSelection = ratio();
        marks.aspectAfter = asp();
        marks.rebuiltAfter = rebuiltAt();
        window.py2dmolOrient.orientTo(r, {animate: false});
        await settle(6);
        F.backToAll = ratio();
        // ...and the mesh must NOT have been rebuilt across any of that, or
        // the stale-framing path was never taken and this proves nothing
        marks.rebuiltAcross = rebuiltAt() !== marks.rebuiltBefore;

        // 🔴 THE MAGNIFICATION IS MONOTONIC, AND A FLIGHT THAT DOES NOT CHANGE
        // IT ANIMATES NOTHING. The scale is
        // `padding * min(w / ax, h / ay) / (2 * extent) * zoom`, and making
        // each INPUT well behaved still leaves the output free to misbehave:
        // the `min` swaps which term binds part way, and the minimum of a
        // rising and a falling function rises and then falls. So the
        // magnification is interpolated directly and the extent solved from
        // it - which also means two identical requests in a row hold it
        // exactly still, the case that was reported.
        const flightOf = async (req) => {
          const seen = [];
          let sampling = true;
          const tick = () => {
            if (!sampling) return;
            seen.push(r._viewScale || 0);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          window.py2dmolOrient.orientTo(r, req);
          await new Promise((done) => setTimeout(done, 2400));
          sampling = false;
          let end = seen.length - 1;
          while (end > 1 && seen[end] === seen[end - 1]) end--;
          const f = seen.slice(0, end + 1);
          const a = f[0];
          const b = f[f.length - 1];
          return {
            from: +a.toFixed(3), to: +b.toFixed(3),
            span: +Math.abs(b - a).toFixed(3),
            // how far the path strays OUTSIDE its own two endpoints
            outside: +Math.max(Math.max(...f) - Math.max(a, b),
              Math.min(a, b) - Math.min(...f)).toFixed(3),
          };
        };
        marks.zoomIn = await flightOf({positions: some});
        marks.zoomRepeat = await flightOf({positions: some});
        marks.zoomOut = await flightOf({});

        // 🔴 AND THE FLIGHT MUST LAND, NOT ARRIVE. `extent` was interpolated
        // per frame and `extentAspect` was assigned only on completion, so the
        // scale - which is a function of both - rotated smoothly and then
        // stepped onto its final value. Reported as "it would first rotate
        // then JUMP to new size".
        //
        // THE SIGNATURE IS THE LAST STEP, not the biggest one: an eased curve
        // is steepest in the middle, and over a twenty-frame flight that frame
        // legitimately carries a sixth of the change. What cannot happen is
        // the change arriving at the END. Measured before the fix: the biggest
        // step was 2.409 of a 6.536 span and it was the FINAL frame; after, the
        // final step is 0.002 and the biggest has moved to the middle.
        const seen = [];
        let sampling = true;
        const tick = () => {
          if (!sampling) return;
          seen.push(r._viewScale || 0);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        window.py2dmolOrient.orientTo(r, {positions: some});
        await new Promise((done) => setTimeout(done, 2600));
        sampling = false;
        // ...trim the still tail, so the statistics are about the flight
        let end = seen.length - 1;
        while (end > 1 && seen[end] === seen[end - 1]) end--;
        const flight = seen.slice(0, end + 1);
        const span = Math.abs(flight[flight.length - 1] - flight[0]);
        let biggest = 0;
        for (let i = 1; i < flight.length; i++) {
          biggest = Math.max(biggest, Math.abs(flight[i] - flight[i - 1]));
        }
        marks.flight = {
          frames: flight.length,
          span: +span.toFixed(3),
          lastStep: +Math.abs(flight[flight.length - 1]
            - flight[flight.length - 2]).toFixed(3),
          // ...and the biggest anywhere, which catches the same fault moved to
          // the OTHER end: snapping the aspect on the FIRST frame instead of
          // the last is just as wrong and leaves the last step small.
          maxStep: +biggest.toFixed(3),
        };

        holder.setAttribute('style', wasStyle);
        window.dispatchEvent(new Event('resize'));
        await settle(4);
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

sc = R.get("sidechains") or {}
print(f"  side chains: {sc.get('atoms')} atoms appended,"
      f" on {sc.get('onMs')} ms (rebuilt={sc.get('onRebuilt')}),"
      f" off {sc.get('offMs')} ms (rebuilt={sc.get('offRebuilt')})")
print(f"    on:  {sc.get('on')}")
print(f"    off: {sc.get('off')}")
if not sc:
    bad.append("the side-chain leg did not run")
elif not sc.get("table"):
    bad.append("this structure carries no side-chain table, so the leg measured"
               " nothing - use a file with full atoms")
else:
    if not sc.get("atoms"):
        bad.append("showing side chains appended no positions, so the leg"
                   " compared two pictures of the same geometry")
    if not sc.get("drew"):
        bad.append("the side chains did not change the picture")
    if not sc.get("same"):
        bad.append("the picture with side chains differs from a forced fresh"
                   " build of the same state")
    if not sc.get("pickSame"):
        bad.append("picking moved when the side chains were rebuilt fresh")
    # ...AND WHAT THE CHANGE ACTUALLY REBUILT. The mesh is three parts - the
    # ribbon, the other sticks (ligands, plates, contacts) and the side chains
    # - and a side-chain click is only the last of those. A heme is 1,822 faces
    # on 4HHB and is exactly as unchanged by the click as the backbone is.
    on = sc.get("on") or {}
    if not on.get("reused"):
        bad.append("a side-chain change rebuilt the RIBBON")
    if not on.get("otherReused"):
        bad.append("a side-chain change rebuilt the ligands and contacts too -"
                   " they are sticks, but they are not the sticks that changed."
                   " Usually this means a face that belongs to a side chain was"
                   " classified into the other group, which moves its hash")
    if not sc.get("back"):
        bad.append("taking the side chains off again did not return to the"
                   " picture before them - something was kept across the change"
                   " and kept stale")
    if not sc.get("backPick"):
        bad.append("picking did not return after the side chains came off")

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

fr = R.get("framing") or {}
mk = R.get("framingMarks") or {}
print(f"  framing marks: aspect {mk.get('aspectBefore')} ->"
      f" {mk.get('aspectAfter')}, rebuild counter"
      f" {mk.get('rebuiltBefore')} -> {mk.get('rebuiltAfter')}")
print("  framing after Orient (drawn scale / wanted scale):"
      f" at rest {fr.get('atRest')}, to a selection"
      f" {fr.get('orientedToSelection')}, back {fr.get('backToAll')}")
if not fr:
    bad.append("the framing check did not run, so a mesh drawn at a stale"
               " scale would go unreported")
if mk.get("rebuiltAcross"):
    bad.append("the mesh was rebuilt during the framing check, so the reused"
               " mesh never had to honour a framing it was not captured under"
               " - the check cannot see the bug it exists for")
if mk.get("aspectBefore") == mk.get("aspectAfter"):
    bad.append(f"the aspect did not change ({mk.get('aspectBefore')}), so a"
               " multiplier that ignores it entirely would pass")
_cv = mk.get("canvas") or [0, 0]
if not _cv[0] or abs(_cv[0] - _cv[1]) < 0.2 * max(_cv[0], 1):
    bad.append(f"the framing check ran on a {_cv} canvas - too square for the"
               " aspect to change which side binds, which is what made the"
               " first version of this test pass against the bug")
for tag, value in fr.items():
    if value is None or abs(value - 1) > 0.02:
        bad.append(f"a reused mesh is drawn at {value} of the scale the viewer"
                   f" wants ({tag}) - the framing multiplier divides out the"
                   " extent but not the shape, so Orient leaves the picture at"
                   " the aspect the mesh was captured under until something"
                   " forces a rebuild. Reported as the zoom not animating and"
                   " needing the box resized to catch up")

for tag in ("zoomIn", "zoomOut", "zoomRepeat"):
    z = mk.get(tag) or {}
    print(f"  orient {tag}: {z.get('from')} -> {z.get('to')}"
          f" (span {z.get('span')}), strays outside its endpoints by"
          f" {z.get('outside')}")
    if not z:
        bad.append(f"the {tag} flight did not run")
        continue
    if z["outside"] > 0.02 * max(z["span"], 0.001) + 0.01:
        bad.append(f"the {tag} flight's magnification left its own endpoints by"
                   f" {z['outside']} - it zooms past and comes back. The scale"
                   " is a min() of two terms, so interpolating extent and"
                   " aspect separately lets the binding axis swap part way and"
                   " the minimum rise then fall")
_zi, _zr = mk.get("zoomIn") or {}, mk.get("zoomRepeat") or {}
if (_zi.get("span") or 0) < 1:
    bad.append("the first flight barely changed the zoom, so the repeat below"
               " proves nothing")
elif _zr.get("span") is None or _zr.get("outside") is None \
        or _zr["span"] > 0.01 or _zr["outside"] > 0.01:
    bad.append(f"asking for the SAME framing twice animated a zoom anyway:"
               f" {_zr} - with both endpoints equal the magnification is"
               " constant by construction, so any movement means it is being"
               " rebuilt from inputs rather than interpolated")

fl = mk.get("flight") or {}
print(f"  animated orient: {fl.get('frames')} frames, scale span"
      f" {fl.get('span')}, final step {fl.get('lastStep')}")
if not fl or not fl.get("frames"):
    bad.append("the animated-orient check did not run")
elif (fl.get("span") or 0) < 0.5:
    bad.append(f"the flight changed the scale by only {fl.get('span')}, so a"
               " jump at the end of it would be too small to see - the check"
               " needs an orient that actually rezooms")
elif fl.get("maxStep", 0) > 0.35 * fl["span"]:
    bad.append(f"one frame of the flight carried {fl['maxStep']} of a"
               f" {fl['span']} scale change - the easing's steepest frame is"
               " worth about a sixth of it over a flight this length, so a"
               " third is a step rather than a curve, wherever it falls")
elif fl["lastStep"] > 0.1 * fl["span"]:
    bad.append(f"the last frame of the flight carried {fl['lastStep']} of a"
               f" {fl['span']} scale change - Orient rotates smoothly and then"
               " JUMPS onto its final size, because extent is interpolated per"
               " frame and extentAspect is only assigned on completion")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
