"""A saved session over what is on screen, or BESIDE it.

    python3 tests/session_append.py

🔴 `loadViewerState` CLEARED EVERY OBJECT AND THERE WAS NO OTHER WAY IN. That
is right for a file a reader DROPS - it replaces the page - and wrong for the
one act where they have asked to see an old fold beside the current one: in
LocalFold, restoring a past session over the fold on screen threw the fold
away. `{append: true}` brings the objects and nothing else.

WHAT IT CHECKS:

  * a plain load still REPLACES, which is every existing caller;
  * an appended load keeps what was there and adds to it;
  * a name already taken is RENAMED rather than merged into - `addObject`
    keeps the frames of an object that already has them, so a session whose
    object shares a name would have appended its frames to the wrong
    trajectory and drawn one structure turning into another;
  * the appended object becomes the CURRENT one, because that is what the
    reader asked to see;
  * and the object ALREADY THERE is not disturbed - not its frames, not its
    own camera. The VIEWER's camera does follow the object landed on, because
    that is what switching to any object does in py2Dmol and every object in
    a session carries its own; what an append must not do is re-frame the
    whole viewer around the file that came to join it, which is a separate
    restore further down the same function.

🔴 THE FIRST VERSION OF THIS ASSERTED THE CAMERA HELD STILL, AND THAT WAS THE
WRONG CLAIM. It failed against correct code: the appended object becomes the
current one and `_switchToObject` restores that object's saved camera, which
is the renderer's rule and not this option's business.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_sessappend.html')

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  const go = async () => {
    const out = { errors: [] };
    try {
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      const txt = await (await fetch('/1UBQ.cif')).text();
      await window.processFiles([{name: '1UBQ.cif',
        readAsync: () => Promise.resolve(txt)}], false);
      await until(loaded);
      await settle(4);

      // The session, through the Save button's own path.
      const saveState = () => {
        const RealBlob = window.Blob;
        let text = null;
        window.Blob = function (parts, opts) { text = parts[0]; return new RealBlob(parts, opts); };
        const realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {};
        window.saveViewerState();
        window.Blob = RealBlob;
        HTMLAnchorElement.prototype.click = realClick;
        return text;
      };
      const captured = saveState();
      const state = JSON.parse(captured);
      out.saved = (state.objects || []).map((o) => o.name);

      const names = () => Object.keys(r.objectsData || {});
      const frames = (n) => (r.objectsData[n]?.frames || []).length;

      // ---- 1 · a plain load still replaces ----
      await window.loadViewerState(JSON.parse(captured));
      await settle(4);
      out.replaced = { names: names(), current: r.currentObjectName };

      // ---- 2 · an appended load joins it, under a name of its own ----
      // ...and the camera is moved first, so "it did not move" means
      // something: restoring the saved one would put these back.
      // 🔴 THE LIVE CAMERA, NOT THE OBJECT'S STORED ONE. Switching away from
      // an object SAVES the live camera into it, so writing 2.5 into the
      // stored copy and appending overwrote it with whatever was on screen -
      // the first version of this read back 1 and blamed the append.
      const held = names()[0];
      r.viewerState.zoom = 2.5;
      const beforeFrames = frames(held);
      await window.loadViewerState(JSON.parse(captured), { append: true });
      await settle(4);
      // 🔴 AND THE PICKER IS A SECOND LIST. Everything above reads
      // objectsData; what a reader sees is the dropdown, and the two can
      // disagree - an object present and unlisted is "the past object is
      // lost" however right the data is.
      const options = () => [...(document.getElementById('objectSelect')?.options ?? [])]
        .map((o) => o.value);
      out.appended = { names: names(), options: options(),
                       current: r.currentObjectName,
                       heldZoom: r.objectsData[held]?.viewerState?.zoom,
                       heldFrames: frames(held), beforeFrames };
      out.framesEach = names().map((n) => [n, frames(n)]);

      // ---- 2b · SWITCHING TO AN OBJECT SHOWS ITS LAST FRAME ----
      // A per-object frame is only written when you switch AWAY, so an
      // object nobody has left has none and used to open at the beginning
      // of its trajectory. For a fold that is the first sampler step, where
      // the last frame is the answer. Built here rather than on the append:
      // what is needed is an object with SEVERAL frames and no remembered
      // position, which is what a fold that has just landed is.
      {
        const api = window.py2Dmol;
        const base = r.objectsData[names()[0]].frames[0];
        // ...four frames: addObject opens an EMPTY object, so this is all
        // of them, and the answer to look for is index 3.
        r.addObject('traj');
        for (let k = 0; k < 4; k++) {
          const f = JSON.parse(JSON.stringify({ coords: base.coords }));
          f.name = f.label = f.title = 'step_' + k;
          r.addFrame(f, 'traj');
        }
        // ...land somewhere else, so the switch below is a real one.
        r._switchToObject(names()[0]);
        await settle(3);
        r._switchToObject('traj');
        await settle(3);
        out.lastFrame = { frames: r.objectsData['traj'].frames.length,
                          at: r.currentFrame };
        // 🔴 AND THE CASE THAT MATTERS IS A STALE REMEMBERED POSITION,
        // which is the one a fold produces: the object is opened and left
        // at frame 0 while it has ONE frame, the sampler fills it while the
        // reader is looking at something else, and coming back used to land
        // at the beginning of a trajectory they had never seen the end of.
        // Leaving at 0 with four frames present stands in for it.
        r.setFrame(0);
        await settle(2);
        r._switchToObject(names()[0]);
        await settle(2);
        r._switchToObject('traj');
        await settle(3);
        out.keptFrame = r.currentFrame;
        // 🔴 AND ASKING FOR THE OBJECT ALREADY SHOWN IS NOT A SWITCH. Two
        // paths call `_switchToObject` with the current name - the sequence
        // strip when a residue of the drawn object is clicked, and the
        // session restore putting a selection back - and moving the frame
        // there drops a reader who has scrubbed into the middle of a
        // trajectory at its end, for clicking on it.
        r.setFrame(1);
        await settle(2);
        r._switchToObject('traj');
        await settle(2);
        out.sameObject = r.currentFrame;
        // 🔴 AND THROUGH THE PICKER, WHICH IS THE ONLY WAY A READER SWITCHES.
        // The rule lives in `_switchToObject`, and the picker's own handler
        // ran `setFrame(0)` straight after it - so every caller landed on the
        // last frame except the control. Reported as: switching between
        // objects should start at the last frame, since that is the final
        // prediction for each object.
        {
          const sel = document.getElementById('objectSelect');
          const pick = async (name) => {
            sel.value = name;
            sel.dispatchEvent(new Event('change', {bubbles: true}));
            await settle(5);
            return r.currentFrame;
          };
          await pick(names()[0]);
          out.pickedOther = r.currentFrame;
          out.picked = await pick('traj');
          out.pickedOf = (r.objectsData['traj'].frames || []).length;
          out.pickedSlider = Number((document.getElementById('frameSlider') || {}).value);
        }
        r.removeObject('traj');
        await settle(2);
      }

      // ---- 2c · AN APPEND DOES NOT BRING THE FILE'S SHOWN SET ----
      // The shown set is the VIEWER's, like the camera and the slab, so a
      // session saved with Multi on must not switch it on for a page that
      // never asked - naming its own objects, which takes what the reader
      // was looking at off the screen.
      {
        const was = names();
        r.setShownObjects(was);
        await settle(2);
        const withMulti = saveState();
        r.setShownObjects(null);
        await settle(2);
        await window.loadViewerState(JSON.parse(withMulti), { append: true });
        // 🔴 PAST THE 100 ms setTimeout, or this leg measures nothing. The
        // shown set is restored from inside that timer, so four frames of
        // settling reads the page BEFORE the line under test has run - and
        // the mutation that removes the guard walks straight through.
        await new Promise((s) => setTimeout(s, 300));
        await settle(3);
        out.appendShown = {
          saved: (JSON.parse(withMulti).viewer_state || {}).shown_objects,
          after: r.shownObjects === null ? 'resting'
            : [...r.shownObjects].join(',')
        };
        // ...and the page goes back to what step 3 expects: this leg is
        // about the shown set, not about how many objects there are.
        for (const n of names()) if (!was.includes(n)) r.removeObject(n);
        r._switchToObject(was[0]);
        await settle(3);
      }

      // ---- 3 · and ONE of them can go, without the other noticing ----
      // The counterpart of addObject, and there was none: the only way to be
      // rid of an object was to be rid of all of them, so a caller recycling
      // its OWN object threw away everything the reader had beside it.
      // Reported through LocalFold: pressing Fold after restoring a past
      // session destroyed the restored fold too.
      r.setShownObjects(names());
      await settle(3);
      const goes = names()[names().length - 1];
      const stays = names()[0];
      const drawnBefore = r.coords.length;
      out.removed = r.removeObject(goes);
      await settle(4);
      out.afterRemove = { names: names(), options: options(),
                          current: r.currentObjectName,
                          frames: frames(stays), drawnBefore,
                          drawn: r.coords.length,
                          shown: r.shownObjects === null ? 'resting'
                            : [...r.shownObjects].join(','),
                          // 🔴 INK, NOT PAPER. Counting pixels with any alpha
                          // counted the BACKGROUND too and came back as the
                          // whole canvas (357,604 of 357,604) whatever was
                          // drawn - a number that cannot fail. What is asked
                          // is how many differ from the corner pixel.
                          ink: (() => {
                            const c = r.canvas;
                            const px = c.getContext('2d')
                              .getImageData(0, 0, c.width, c.height).data;
                            const bg = [px[0], px[1], px[2]];
                            let n = 0;
                            for (let i = 0; i < px.length; i += 4) {
                              if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1])
                                  + Math.abs(px[i + 2] - bg[2]) > 24) n += 1;
                            }
                            return n;
                          })() };
      // ...and removing the last one is the same act as clearing.
      out.removedLast = r.removeObject(stays);
      await settle(3);
      out.empty = { names: names(), current: r.currentObjectName };
    } catch (e) { out.errors.push(String(e && e.stack || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
  };
  go();
});
</script>
"""
JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)

open(PROBE, 'w').write(
    re.sub(r'(src="(?:\./)?src/[^"]+?\.js)(\?[^"]*)?(")',
           lambda m: m.group(1) + '?v=' + str(int(time.time())) + m.group(3),
           open(os.path.join(ROOT, 'dev.html')).read()).replace('</body>', JS + '</body>'))
box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
        self.send_response(200); self.send_header('Content-Length', '2')
        self.end_headers(); self.wfile.write(b'ok')


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9304), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
proc = subprocess.Popen([CHROME, '--headless=new',
                         '--user-data-dir=/tmp/py2dmol-sessappend', '--no-first-run',
                         '--window-size=1200,1000',
                         'http://127.0.0.1:9304/_sessappend.html'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
proc.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree('/tmp/py2dmol-sessappend', ignore_errors=True)
R = box[0] if box else {'errors': ['no result posted']}

print(f"  saved     {R.get('saved')}")
print(f"  replaced  {R.get('replaced')}")
print(f"  appended  {R.get('appended')}")
print(f"  frames    {R.get('framesEach')}")
print(f"  removed   {R.get('removed')} -> {R.get('afterRemove')}")
print(f"  last one  {R.get('removedLast')} -> {R.get('empty')}")

bad = list(R.get('errors') or [])
rep = R.get('replaced') or {}
app = R.get('appended') or {}
# 🔴 EVERY READ IS GUARDED, because the failures this exists to catch are
# exactly the ones that leave the list SHORT - and an IndexError exits 1 with
# a traceback instead of the sentence that says what went wrong. Both
# mutations below did that before these were written.
rep_names = rep.get('names') or []
app_names = app.get('names') or []
if len(rep_names) != 1:
    bad.append(f"a plain load did not replace: {rep} - every existing caller"
               " depends on it clearing first")
if len(app_names) != 2:
    bad.append(f"an appended load did not join what was there: {app} - one"
               " name means it either cleared first or merged into the object"
               " already here")
elif app_names[1] == rep_names[0] if rep_names else False:
    bad.append(f"the appended object took the name already in use: {app} -"
               " addObject keeps the frames of an object that has them, so"
               " that is two folds in one trajectory")
if (app.get('options') or []) != app_names:
    bad.append(f"the object LIST does not match the objects: options"
               f" {app.get('options')} against {app_names} - an object that"
               " is present and unlisted is lost as far as a reader is"
               " concerned, which is how this was reported")
if app_names and app.get('current') != app_names[-1]:
    bad.append(f"the appended object is not the current one: {app} - a reader"
               " who asks for an old fold is asking to be editing it")
if app.get('heldZoom') != 2.5:
    bad.append(f"the object the reader was on did not keep the camera they"
               f" were using: {app} - switching away saves it, and an append"
               " brings a file's objects and disturbs nothing else")
if app.get('heldFrames') != app.get('beforeFrames'):
    bad.append(f"the object already on screen changed length: {app} - that is"
               " the appended frames landing in the wrong trajectory")
for name, n in (R.get('framesEach') or []):
    if n < 1:
        bad.append(f"{name} came back with {n} frames")

lf = R.get('lastFrame') or {}
print(f"  last frame {lf}, and a chosen one is kept at {R.get('keptFrame')}")
if lf.get('frames') != 4:
    bad.append(f"the trajectory leg did not build what it needed: {lf}")
elif lf.get('at') != 3:
    bad.append(f"switching to an object opened it at frame {lf.get('at')} of"
               f" {lf.get('frames')} - an object nobody has left has no"
               " remembered position, and the last frame is the answer a fold"
               " gives where the first is its coarsest sampler step")
if R.get('keptFrame') != 3:
    bad.append(f"coming back to an object left at frame 0 opened it at"
               f" {R.get('keptFrame')}, not its last frame - a remembered"
               " position goes stale exactly where this was asked about: a"
               " fold is left at 0 with one frame and fills up afterwards")

if R.get('sameObject') != 1:
    bad.append(f"asking for the object already shown moved the frame to"
               f" {R.get('sameObject')}, not the 1 the reader had scrubbed"
               " to - the sequence strip and the session restore both call"
               " _switchToObject with the current name, and neither is a"
               " switch")

rm = R.get('afterRemove') or {}
if not R.get('removed'):
    bad.append("removeObject refused an object that was there")
if len(rm.get('names') or []) != 1:
    bad.append(f"removing one object left {rm.get('names')} - it takes one")
if rm.get('current') != (rm.get('names') or [None])[0]:
    bad.append(f"the reader was left editing an object that is gone: {rm}")
# 🔴 THE SHOWN SET IS WHERE A DEAD NAME DOES ITS DAMAGE: a set naming an
# object that no longer exists is Multi over a merge of one, with the button
# lit and the frames refusing to advance.
print(f"  through the PICKER: frame {R.get('picked')} of {R.get('pickedOf')}"
      f" (slider {R.get('pickedSlider')})")
if R.get('picked') != (R.get('pickedOf') or 0) - 1:
    bad.append(f"picking an object in the object menu opened it at frame"
               f" {R.get('picked')} of {R.get('pickedOf')} - the control has"
               " to land where _switchToObject landed, and its own setFrame(0)"
               " used to win")
if R.get('pickedSlider') != R.get('picked'):
    bad.append(f"the play strip says frame {R.get('pickedSlider')} while the"
               f" viewer is on {R.get('picked')}")

ash = R.get('appendShown') or {}
print(f"  a session saved with Multi on, appended: saved"
      f" {ash.get('saved')} -> page {ash.get('after')}")
if not isinstance(ash.get('saved'), list) or len(ash.get('saved') or []) < 2:
    bad.append(f"the Multi leg did not save a shown set: {ash} - it cannot"
               " say anything about an append that ignores one")
if ash.get('after') != 'resting':
    bad.append(f"an appended session brought its own shown set: {ash} - the"
               " page was at rest and is now merging the file's objects")

if rm.get('shown') not in ('resting', (rm.get('names') or [None])[0]):
    bad.append(f"the shown set still names the object that went: {rm}")
if (rm.get('ink') or 0) <= 0:
    bad.append(f"nothing is drawn after removing one of two: {rm} - the"
               " object that stayed has to still be on screen")
if (rm.get('options') or []) != (rm.get('names') or []):
    bad.append(f"after removing one, the list still offers it: {rm}")
if rm.get('frames') != 1:
    bad.append(f"the object that stayed lost frames: {rm}")
# 🔴 AND THE PICTURE IS REBUILT. With several objects drawn the array is a
# MERGE, and taking one out of the shown set does not rebuild it by itself:
# the names, the set and the current object can all be right while the object
# that left is still in the coordinates. Measured as HALF, because the two
# objects here are the same structure.
if rm.get('drawn') != (rm.get('drawnBefore') or 0) / 2:
    bad.append(f"the drawn array still holds the object that went:"
               f" {rm.get('drawn')} positions against {rm.get('drawnBefore')}"
               " for two copies of it - removing one must rebuild the merge")
if (R.get('empty') or {}).get('names'):
    bad.append(f"removing the last object left something behind:"
               f" {R.get('empty')} - that is clearAllObjects by another name")

if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('session_append: ok')
