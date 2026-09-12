"""Two objects of DIFFERENT LENGTH share one timeline, and the policy is what
the short one does past its own end.

    python3 tests/frame_policy.py

🔴 A FRAME INDEX IS NOT A SHARED CLOCK. The play strip read the frame count of
the object being EDITED and advanced that object's index alone, so a 100-frame
trajectory beside a 20-frame one left the second frozen on frame 0 for the
whole run - two structures on screen together, one of them moving, and nothing
saying why. What is shared is a POSITION; each object turns it into a frame of
its own through `_frameForObject`, and `_timelineLength` is the longest one.

The three policies are three different claims and the probe asks for each:

  hold (default) - the short one stops on its last frame. Claims nothing.
  loop           - claims the short one is periodic.
  stretch        - claims the two are the same process sampled differently, so
                   the ends must meet: first frame to first, last to last.

🔴 AND AN INDEX CHECK ALONE WOULD PASS AGAINST A NO-OP. `_parkedFrameIndex` is
arithmetic and every one of these answers can be right while the coordinate
array holds a frame nobody asked for - which is precisely the bug, since
`_arrayKey` decides whether to rebuild. So every position is read TWICE: the
index the funnel resolved, and the y of the object's own slice of the merged
array, which is frame*10 A by construction. The two must agree.

The fixtures are synthetic on purpose - two chains of 12 residues, one 10
frames long and one 4 - because what is being measured is an index and a
translation, and a real structure brings a cartoon, an alignment and a load
time with it to measure the same two numbers.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_framepolicy.html")
LONG, SHORT = 10, 4

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {at: [], policies: {}};
    try {
      // 🔴 ONE REAL FILE FIRST, AND NOT FOR ITS COORDINATES. The page sizes
      // its canvas when a structure arrives; built straight through addObject
      // the viewer runs at 1x1 and every pixel measurement below is taken of
      // nothing - a blank canvas is ONE picture at every position, which is
      // exactly what "the picture never moved" looks like, so the two are
      // indistinguishable until the canvas has a size. Measured: 1x1 before,
      // and the ink check at the end is the standing guard.
      await load('1UBQ.cif'); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      const NL = %d; const NS = %d;

      // A CHAIN OF 12 RESIDUES 3.8 A APART, and frame k is the whole thing
      // moved 10 A along y - so the y of what is drawn SAYS which frame it is,
      // with no cartoon, no alignment and no parsing in the way.
      //
      // `align` is left off every frame: addFrame superposes a frame on the
      // one before it when asked, which would undo the very displacement this
      // measurement reads. And a coord entry is an ARRAY - rebuilding one as
      // {x, y, z} drops whatever else it carries and blanks the viewer.
      const frame = (k) => ({
        coords: Array.from({length: 12}, (_, i) => [i * 3.8, k * 10, 0]),
        chains: Array(12).fill('A'),
        position_types: Array(12).fill('P'),
        position_names: Array(12).fill('ALA'),
        residue_numbers: Array.from({length: 12}, (_, i) => i + 1),
        plddts: Array(12).fill(90),
      });
      const build = (name, n) => {
        r.addObject(name);
        for (let k = 0; k < n; k++) r.addFrame(frame(k), name);
      };
      build('long', NL);
      build('short', NS);
      r.setStyle('tube', true);
      r._switchToObject('long');
      // ...the two synthetic ones ALONE: 1UBQ was loaded for the layout and
      // showing it too would put a third structure in every picture.
      r.setShownObjects(['long', 'short'], false, {reframe: true});
      await settle(4);
      R.canvas = [r.canvas.width, r.canvas.height];

      R.timeline = r._timelineLength();
      R.counts = {long: r.objectsData.long.frames.length,
                  short: r.objectsData.short.frames.length};

      // WHAT THE ARRAY ACTUALLY HOLDS for one object, in Angstrom. The merge
      // concatenates the drawn objects and records where each starts, so this
      // reads that object's own first position out of the merged coordinates -
      // which is the only reading that cannot be satisfied by arithmetic.
      const drawnY = (name) => {
        const ms = r.multiState;
        const k = (ms.sourceNames || []).indexOf(name);
        if (k < 0) return null;
        const p = r.coords[(ms.sourceOffsets || [])[k]];
        if (!p) return null;
        return Math.round((p.y === undefined ? p[1] : p.y) * 100) / 100;
      };
      // ...and y is measured relative to the structure's own centre, which the
      // renderer subtracts, so what is compared between two objects is their
      // DIFFERENCE - 10 A per frame apart.
      const sample = (t) => {
        r.setFrame(t);
        return {t,
                idx: {long: r._parkedFrameIndex('long'),
                      short: r._parkedFrameIndex('short')},
                gap: Math.round((drawnY('short') - drawnY('long')) * 10) / 10};
      };

      const sweep = () => {
        const out = [];
        for (let t = 0; t < NL; t++) out.push(sample(t));
        return out;
      };
      R.policies.hold = sweep();
      r.setFramePolicy('loop', 'short');
      R.policies.loop = sweep();
      r.setFramePolicy('stretch', 'short');
      R.policies.stretch = sweep();
      r.setFramePolicy('hold', 'short');

      // THE STRIP GOVERNS THE TIMELINE, not the edited object. With `short`
      // the object being edited, the slider must still reach the longest
      // object's last frame - bounded by the edited object's own count, every
      // position past 3 blanked the canvas outright.
      r.setFrame(0);
      r.objectSelect.value = 'short';
      r.objectSelect.dispatchEvent(new Event('change'));
      await settle(3);
      R.editedShort = {
        max: Number(r.frameSlider.max),
        counter: (r.frameCounter.textContent || '').replace(/\\s+/g, ''),
        playShown: getComputedStyle(r.playButton).display !== 'none',
      };
      // ...and a position past its end is ordinary rather than an error
      r.setFrame(NL - 1);
      await settle(2);
      R.editedShort.atEnd = {idx: r._parkedFrameIndex('short'),
                             coords: r.coords.length,
                             gap: Math.round((drawnY('short') - drawnY('long')) * 10) / 10};

      // AND PICKING AN OBJECT TO WORK ON DOES NOT MOVE ANYTHING, which is the
      // camera's rule applied to the timeline. The picker used to reset to
      // frame 0, so choosing the reference structure took the trajectory
      // beside it back to its first frame.
      r.setFrame(6);
      r.objectSelect.value = 'long';
      r.objectSelect.dispatchEvent(new Event('change'));
      await settle(3);
      R.afterSwitch = {t: r.currentFrame,
                       idx: r._parkedFrameIndex('long')};

      // AND ORIENT IS THE SAME FAULT IN A SECOND PLACE. `orientToBestView`
      // read `object.frames[renderer.currentFrame]` - this object's frames at
      // the shared position - so with the short object edited and the strip
      // past its end the lookup was undefined and it returned having done
      // nothing at all. Measured as a camera that moved.
      r._switchToObject('short');
      r.setFrame(NL - 1);
      await settle(2);
      const rot0 = JSON.stringify(r.viewerState.rotation);
      const span0 = r._viewHalfSpan ? JSON.stringify(r._viewHalfSpan()) : null;
      window.py2dmolOrient.orientTo(r, {animate: false});
      await settle(3);
      R.orient = {moved: JSON.stringify(r.viewerState.rotation) !== rot0
                      || (r._viewHalfSpan
                          ? JSON.stringify(r._viewHalfSpan()) !== span0 : false)};

      // PLAYBACK RUNS THE TIMELINE. It advanced over the edited object's own
      // count, so with `short` edited it stopped dead after four frames while
      // the long object beside it still had six to show.
      //
      // 🔴 AND WHAT IS COUNTED IS THE CANVAS, not the counter and not the
      // coordinate array. Two weaker versions of this leg both passed against
      // a viewer whose picture never moved: `r.currentFrame` is advanced by
      // the frame timer, and the ARRAY is rebuilt by it too - but the render
      // loop decides whether to PAINT, and it asked
      // `object.frames[currentFrame]` of the EDITED object, which a short one
      // does not have. So the position advanced, the array was correct, and
      // the canvas held still. Reported as "the one with more frames also
      // stops", with every index in this probe already right.
      //
      // The digest is a 160x160 downsample of the real canvas summed with
      // position weights - the structure moves 10 A a frame, so every frame is
      // a different picture, and the number of DISTINCT images is the number
      // of frames a reader saw.
      //
      // 🔴 AND IT IS TAKEN INSIDE render(), NOT FROM A POLLING LOOP. Sampling
      // the canvas from rAF counts whatever the scheduler let it see: in the
      // parallel lane, with six browsers up, it read 8 pictures of 10 against
      // a bound of 9 and failed on nothing at all. Every paint digests itself
      // now, so the count is exact and there is no timing window - the same
      // lesson as "a bound a fraction above the measured value fails on
      // noise",
      // arrived at from the other side.
      r._switchToObject('short');
      r.setFrame(0);
      const small = document.createElement('canvas');
      small.width = 160; small.height = 160;
      const sctx = small.getContext('2d');
      const digest = () => {
        sctx.clearRect(0, 0, 160, 160);
        sctx.drawImage(r.canvas, 0, 0, 160, 160);
        const d = sctx.getImageData(0, 0, 160, 160).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 4) {
          h = (h + (i + 1) * (d[i] + 3 * d[i + 1] + 7 * d[i + 2])) %% 2147483647;
        }
        return h;
      };
      // ...AND THE DIGEST IS FILED UNDER THE POSITION IT WAS DRAWN AT. A
      // plain count of distinct images is not the question either: a render
      // can happen twice at one position for reasons of its own (a UI sync, a
      // resize), which read 10 paints and 8 distinct pictures on correct code.
      // What has to hold is that every position the counter reached was
      // PAINTED, and that each painted position looks different from the
      // others - both exact, neither dependent on when the probe looked.
      const seen = new Set();
      const byPos = new Map();
      let painted = 0;
      const wrapped = r.render.bind(r);
      r.render = function (...a) {
        const out = wrapped(...a);
        painted++;
        byPos.set(r.currentFrame, digest());
        return out;
      };
      r.startAnimation();
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && seen.size < NL) {
        seen.add(r.currentFrame);
        await settle(1);
      }
      r.stopAnimation();
      r.render = wrapped;
      R.played = [...seen].sort((a, b) => a - b);
      R.painted = painted;
      R.paintedAt = [...byPos.keys()].sort((a, b) => a - b);
      // CONTEXT ONLY, and said out loud: the digest is taken as render()
      // returns, and on the GPU path the canvas does not necessarily hold the
      // frame just submitted - positions 0, 1 and 2 share an image at the
      // start of a playback while every later one differs. So this number is
      // printed and NOT asserted; what is asserted is `paintedAt`, which is
      // exact, and the deterministic sweep below.
      R.drawnPositions = new Set(byPos.values()).size;

      // 🔴 AND THAT THE PICTURE DEPENDS ON THE POSITION AT ALL, measured where
      // there is no race: setFrame paints synchronously, so a settle after it
      // means the canvas holds that frame. This is the guard against a render
      // that runs and draws the same thing - which every count above would
      // pass. Three positions: inside the short object's own frames, past its
      // end, and the last.
      const shots = [];
      for (const t of [0, 4, NL - 1]) {
        r.setFrame(t);
        await settle(4);
        shots.push(digest());
      }
      R.distinctShots = new Set(shots).size;
      // ...AND THAT THERE IS A STRUCTURE ON THE CANVAS TO COUNT PICTURES OF.
      // A blank canvas is one picture at every position and passes nothing.
      sctx.clearRect(0, 0, 160, 160);
      sctx.drawImage(r.canvas, 0, 0, 160, 160);
      const dd = sctx.getImageData(0, 0, 160, 160).data;
      let ink = 0;
      for (let i = 0; i < dd.length; i += 4) {
        if (dd[i] < 240 || dd[i + 1] < 240 || dd[i + 2] < 240) ink++;
      }
      R.ink = ink;
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
""" % (LONG, SHORT)
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS)
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9784), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-framepolicy",
                      "--no-first-run", "--window-size=900,700",
                      "http://127.0.0.1:9784/_framepolicy.html"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-framepolicy", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
print(f"  {R.get('counts')}  timeline={R.get('timeline')}")
if R.get("timeline") != LONG:
    bad.append(f"the timeline is {R.get('timeline')} and the longest object has"
               f" {LONG} frames - the strip cannot reach the end of it")

# What each policy must answer at every position, and the gap in Angstrom that
# proves the coordinate array agrees: 10 A per frame of difference.
want = {
    "hold": [min(t, SHORT - 1) for t in range(LONG)],
    "loop": [t % SHORT for t in range(LONG)],
    "stretch": [round(t * (SHORT - 1) / (LONG - 1)) for t in range(LONG)],
}
for name, expect in want.items():
    rows = R.get("policies", {}).get(name) or []
    if len(rows) != LONG:
        bad.append(f"{name}: {len(rows)} positions sampled, wanted {LONG}")
        continue
    got = [row["idx"]["short"] for row in rows]
    gaps = [row["gap"] for row in rows]
    print(f"  {name:<8} short frame {got}")
    print(f"           drawn gap/A {gaps}")
    if [row["idx"]["long"] for row in rows] != list(range(LONG)):
        bad.append(f"{name}: the long object did not follow the timeline -"
                   f" {[row['idx']['long'] for row in rows]}")
    if got != expect:
        bad.append(f"{name}: the short object resolved {got}, wanted {expect}")
    # 🔴 THE INDEX IS THE CLAIM AND THE COORDINATES ARE THE PROOF. Every
    # arithmetic check above passes against a resolved index the array was
    # never rebuilt from, which is the whole bug - _arrayKey decides.
    for row, w in zip(rows, expect):
        if abs(row["gap"] - (w - row["idx"]["long"]) * 10) > 0.2:
            bad.append(f"{name}: at position {row['t']} the funnel says frame"
                       f" {row['idx']['short']} and the drawn coordinates are"
                       f" {row['gap']} A from the long object, which is frame"
                       f" {row['gap'] / 10 + row['idx']['long']:.1f} - the"
                       " array was not rebuilt for the frame that was resolved")
            break

es = R.get("editedShort") or {}
print(f"  editing the short object: slider max={es.get('max')}"
      f" counter={es.get('counter')} play={es.get('playShown')} {es.get('atEnd')}")
if es.get("max") != LONG - 1:
    bad.append(f"with the 4-frame object edited the slider stops at"
               f" {es.get('max')} - the timeline is {LONG} long and every"
               " position past the edited object's own end was unreachable")
# The counter says the TIMELINE, not the edited object's own length: the
# timeline was set to 0 just above and the picker holds it there.
if es.get("counter") != f"1/{LONG}":
    bad.append(f"the counter reads {es.get('counter')!r} with the 4-frame"
               f" object edited, wanted '1/{LONG}' - it was reading that"
               " object's own frame count")
if not es.get("playShown"):
    bad.append("the play button is hidden while a 10-frame object is on screen"
               " - it was asked of the edited object's own frame count")
end_at = es.get("atEnd") or {}
if end_at.get("idx") != SHORT - 1:
    bad.append(f"at the last position the short object is on frame"
               f" {end_at.get('idx')}, wanted {SHORT - 1}")
if not end_at.get("coords"):
    bad.append("the coordinate array is EMPTY at a position past the edited"
               " object's last frame - setFrame blanked the canvas instead of"
               " letting each object resolve the position")

sw = R.get("afterSwitch") or {}
print(f"  after picking another object to edit: t={sw.get('t')} long frame={sw.get('idx')}")
if sw.get("t") != 6:
    bad.append(f"picking an object to work on moved the timeline to"
               f" {sw.get('t')} - it is the picture's, like the camera, and"
               " resetting it took the trajectory back to its first frame")

if not (R.get("orient") or {}).get("moved"):
    bad.append("Orient did nothing with the 4-frame object edited and the strip"
               " past its end - it indexed that object's frames with the shared"
               " position and found nothing there")

played = R.get("played") or []
print(f"  playback reached positions {played}, painted at"
      f" {R.get('paintedAt')} in {R.get('painted')} renders"
      f" ({R.get('drawnPositions')} distinct images, context only);"
      f" {R.get('distinctShots')}/3 distinct on a settled sweep;"
      f" ink={R.get('ink')} of 25600, canvas={R.get('canvas')}")
if not R.get("ink"):
    bad.append("the canvas is BLANK - the picture count above is counting"
               " nothing and proves nothing")
if len(played) < LONG:
    bad.append(f"playback reached {len(played)} of {LONG} positions while the"
               " 4-frame object was the one being edited - it advanced over"
               " that object's own count and stopped there")
# 🔴 THE COUNTER ADVANCING IS NOT THE PICTURE MOVING. Allow one: the loop can
# sample the same coordinates twice at the ends, and the point is that most of
# the timeline reached the canvas rather than exactly all of it.
# 🔴 EVERY POSITION THE COUNTER REACHED HAD TO BE PAINTED, and every paint has
# to be a DIFFERENT picture. The first is what the broken render gate fails -
# it painted only the four positions the edited object had frames for - and the
# second is what a paint that redraws the same thing fails. Both are exact:
# render() counts and digests itself, so neither depends on when the probe
# happened to look.
painted_at = R.get("paintedAt") or []
if len(painted_at) < len(played):
    bad.append(f"the counter reached {len(played)} positions and only"
               f" {len(painted_at)} of them were ever painted ({painted_at})"
               " - the frame advanced, the coordinate array was rebuilt, and"
               " the picture held still, which is what a render loop asking the"
               " EDITED object for a frame it does not have looks like from the"
               " reader's seat")
# ...and the deterministic one: three positions, three pictures. Without this
# every count above passes for a viewer that paints diligently and draws the
# same thing each time.
if (R.get("distinctShots") or 0) < 3:
    bad.append(f"three positions across the timeline gave"
               f" {R.get('distinctShots')} distinct pictures - the canvas does"
               " not depend on where the strip is")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
