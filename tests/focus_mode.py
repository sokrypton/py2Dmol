"""Focus is a MODE: it borrows the viewer and gives it back.

    python3 tests/focus_mode.py                      # 4HHB on dev.html

`focusOn` and `clearFocus` are checked as verbs in tests/cut_ligands.py. This
is about the door at each end - what pressing the button does, and what
pressing it again leaves behind.

A mode that leaves anything of its own behind is worse than no mode. A reader
who turns Focus off wants the picture they had, not that picture plus a dozen
side chains, a slab and a selection they never made. And they want the mode to
start from the structure rather than from their leftovers: side chains they
turned on by hand look exactly like ones focus drew, and a slab from before
cuts the neighbourhood the mode moves to.

So, with a deliberately messy state set up first - a selection, side chains on
other residues, a clip, a turned camera, a zoom:

  ENTERING clears the side chains and the slab and does NOT touch the angle.
  What it does with the SELECTION depends on whether there is one, and the
  difference is the point: side chains and a slab are decorations somebody
  turned on and forgot, while a selection is "this is what I am looking at".

    with nothing selected  nothing moves at all. A mode that rearranged the
                           picture the moment it was pressed is a button.
    with a selection       it focuses THAT, straight away - pressing Focus
                           with something picked is asking to look at it
                           closer, not to pick it again.

  A CLICK inside the mode replaces the focus - the mode working.

  LEAVING puts back everything the mode CHANGED: the same selection, the same
  side chains on the same objects, the same slab, the same centre and zoom.
  Not the angle - if the camera turned, the reader turned it, and it is theirs
  to keep. This probe turns it deliberately while inside the mode and requires
  the turn to survive.

  AND THE SELECTION PANEL STAYS AWAY while the mode is on. There is always a
  selection in focus - the residue you just clicked - so the panel would slide
  in and sit there, and its buttons act on a selection that is the mode's
  bookmark rather than something the reader built up to act on.

That is the one asymmetry in the mode and it is the whole reason the snapshot
is not simply "the viewer": what the mode borrows it gives back, and what the
reader does inside it stands.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_focusmode.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "4HHB.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f')); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.styleChosen = true;
      r.setStyle('cartoon');
      await settle();

      // ...the flight has to land before anything is measured
      const landed = () => until(() => !r._focusAnim, 3000);
      const sidechainsOf = () => Object.fromEntries(
        Object.keys(r.objectsData).map((k) => [k,
          r.objectsData[k].sidechains instanceof Set
            ? [...r.objectsData[k].sidechains].sort((a, b) => a - b).join(',') : '']));
      const state = () => ({
        sel: r.residueSelection instanceof Set
          ? [...r.residueSelection].sort((a, b) => a - b).join(',') : '',
        sc: sidechainsOf(),
        clipOn: !!(r.clipSlabOn && r.clipSlabOn()),
        clip: (r.clipSlabOn && r.clipSlabOn())
          ? [+r.clipNear.toFixed(3), +r.clipFar.toFixed(3)] : null,
        rot: JSON.stringify(r.viewerState.rotation.map(
          (row) => row.map((v) => +v.toFixed(4)))),
        zoom: +r.viewerState.zoom.toFixed(4),
        center: r.viewerState.center
          ? [+r.viewerState.center.x.toFixed(3), +r.viewerState.center.y.toFixed(3),
             +r.viewerState.center.z.toFixed(3)] : null,
        panelHidden: (() => {
          const p = document.getElementById('selectionPanel');
          return p ? !!p.hidden : null;
        })(),
        pressed: (() => {
          const b = document.getElementById('focusButton');
          return b ? b.getAttribute('aria-pressed') : null;
        })(),
        n: r.coords.length,
        mark: r.selectionMark || 'highlight',
        markSel: (() => {
          const el = document.getElementById('selectionMarkSelect');
          return el ? el.value : null;
        })(),
      });

      const btnEl = document.getElementById('focusButton');

      // LEG ONE: ENTER WITH NOTHING SELECTED. Nothing may move.
      r.setResidueSelection(new Set());
      r.render('bare'); await settle(); await settle();
      R.bareBefore = state();
      btnEl.click();
      await settle(); await landed(); await settle();
      R.bareEntered = state();
      btnEl.click();
      await settle(); await landed(); await settle();

      // LEG TWO: a messy state of the kind a reader actually builds - some
      // residues selected, side chains on OTHER ones, a slab, a turned camera.
      const first = Object.keys(r.objectsData)[0];
      r.objectsData[first].sidechains = new Set([20, 21, 22, 23, 24, 25]);
      r._invalidateSegmentCache();
      r.reloadDrawn(true);
      r.setResidueSelection(new Set([5, 6, 7, 8, 9]));
      if (r.setClipSlab) r.setClipSlab(-8, 8);
      r.viewerState.rotation = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
      r.viewerState.zoom = 1.7;
      r._invalidateScreenProjection();
      r.render('setup'); await settle(); await settle();
      R.before = state();

      // ENTER, with that selection standing
      const btn = btnEl;
      btn.click();
      await settle(); await landed(); await settle();
      R.entered = state();

      // A CLICK INSIDE THE MODE
      r.focusOn({positions: [40]});
      await settle(); await landed(); await settle();
      R.focused = state();

      // ...AND THE READER TURNS THE VIEW while they are in there, which is
      // the one thing the mode must NOT undo.
      r.viewerState.rotation = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
      r._invalidateScreenProjection();
      r.render('turned'); await settle();
      R.turned = state();

      // LEAVE
      btn.click();
      await settle(); await landed(); await settle();
      // the camera tween is what takes longest; give it a second landing
      await landed(); await settle();
      R.after = state();

      // LEG THREE: CLICKING AWAY inside the mode. That zooms back out and
      // leaves the reader in focus, ready for the next click - so it must not
      // re-mark what they had selected before they pressed the button. They
      // have moved on from it; the mode gives it back when they LEAVE.
      r.setResidueSelection(new Set([5, 6, 7, 8, 9]));
      await settle();
      btn.click();                       // enter (focuses 5-9)
      await settle(); await landed(); await settle();
      r.focusOn({positions: [40]});      // look at something else
      await settle(); await landed(); await settle();
      r.clearFocus();                    // ...and click the background
      await settle(); await landed(); await settle();
      R.cleared = state();
      btn.click();                       // leave
      await settle(); await landed(); await settle();
      R.afterCleared = state();

      // LEG FOUR: the reader picks a mark THEMSELVES while inside the mode.
      // That is a choice about how they want selections marked, not something
      // focus borrowed, so it has to survive the way out - the same line the
      // rotation is on.
      r.setResidueSelection(new Set([5, 6, 7]));
      await settle();
      btn.click();                       // enter (focuses that selection)
      await settle(); await landed(); await settle();
      const mk = document.getElementById('selectionMarkSelect');
      mk.value = 'none'; mk.dispatchEvent(new Event('change'));
      await settle();
      R.chose = state();
      btn.click();                       // leave
      await settle(); await landed(); await settle();
      R.afterChose = state();

      // LEG FIVE: CLEAR ALL while the mode is on. Nothing of it may survive -
      // the snapshot names objects that are about to stop existing, and a
      // latch that outlives the clear puts the NEXT structure straight into a
      // mode nobody asked for, wearing this session's mark.
      r.setResidueSelection(new Set([5, 6, 7]));
      await settle();
      // ...WHAT THE READER'S MARK WAS BEFORE THE MODE TOOK IT. Not
      // necessarily the default: the leg above left them on their own choice,
      // and Clear All resets the STRUCTURE, not a preference.
      R.markBeforeClearLeg = r.selectionMark;
      btn.click();
      await settle(); await landed(); await settle();
      R.beforeClear = state();
      const clearBtn = document.getElementById('clearAllButton');
      R.hasClear = !!clearBtn;
      if (clearBtn) clearBtn.click();
      await settle(); await settle();
      R.afterClear = {
        mode: !!r._focusMode, entry: !!r._focusEntry, prev: !!r._focusPrev,
        busy: !!r._focusBusy, anim: !!r._focusAnim,
        mark: r.selectionMark, markSel: state().markSel,
        pressed: state().pressed, objects: Object.keys(r.objectsData).length,
      };
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9765), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-focusmode",
                      "--no-first-run", "--window-size=1100,900",
                      "http://127.0.0.1:9765/_focusmode.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-focusmode", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

before, entered, focused, after = (R.get(k) or {} for k in
                                   ("before", "entered", "focused", "after"))
bad = []
if not before or not after:
    sys.exit("the probe did not complete: " + json.dumps(R)[:400])

scOf = lambda st: ','.join(f"{k}:{v}" for k, v in sorted((st.get('sc') or {}).items()))
print(f"  before   sel={before['sel']!r} sc={scOf(before)!r} clip={before['clip']}"
      f" zoom={before['zoom']} pressed={before['pressed']}")
print(f"  entered  sel={entered['sel']!r} sc={scOf(entered)!r} clip={entered['clip']}"
      f" zoom={entered['zoom']} pressed={entered['pressed']}"
      f" panelHidden={entered['panelHidden']}")
print(f"  focused  sel={focused['sel']!r} atoms={focused['n'] - before['n']:+d}"
      f" zoom={focused['zoom']} panelHidden={focused['panelHidden']}")
turned_st = R.get("turned") or {}
print(f"  turned   the reader's angle inside the mode"
      f" (differs from before: {turned_st.get('rot') != before['rot']})")
print(f"  after    sel={after['sel']!r} sc={scOf(after)!r} clip={after['clip']}"
      f" zoom={after['zoom']} pressed={after['pressed']}"
      f" keptAngle={after['rot'] == turned_st.get('rot')}")

# ---- the setup has to be worth restoring
if not before['sel'] or not any((before['sc'] or {}).values()) or not before['clipOn']:
    bad.append("the state before focus was not messy enough to test a restore:"
               f" {before['sel']!r} {scOf(before)!r} clip={before['clipOn']}")

# ---- ENTERING: a clean slate, and the camera untouched
bare0, bare1 = (R.get(k) or {} for k in ("bareBefore", "bareEntered"))
if not bare0 or not bare1:
    bad.append("the empty-selection leg did not run")
else:
    print(f"  bare     entered with nothing selected:"
          f" sel={bare1['sel']!r} centre moved={bare1['center'] != bare0['center']}")
    if bare1['sel']:
        bad.append(f"entering with nothing selected picked {bare1['sel']!r} on"
                   " its own")
    if bare1['center'] != bare0['center'] or bare1['rot'] != bare0['rot']:
        bad.append("entering with nothing selected moved the view - a mode that"
                   " rearranges the picture the moment it is pressed is a button")

if entered['sel'] != before['sel']:
    bad.append(f"entering focus with {before['sel']!r} selected changed it to"
               f" {entered['sel']!r} - a selection is what the reader is looking"
               " at, and pressing Focus asks to look at it closer")
if entered['n'] <= before['n']:
    bad.append("entering focus with a selection drew no side chains - it should"
               " focus what was picked rather than wait for a click saying so")
if entered['center'] == before['center']:
    bad.append("entering focus with a selection did not move in on it")
if scOf(entered) == scOf(before):
    bad.append(f"the side chains showing before focus ({scOf(before)!r}) are"
               " still exactly those - the ones the reader turned on must go,"
               " or they cannot be told from the ones focus drew")
if entered['rot'] != before['rot']:
    bad.append("entering focus turned the camera - the mode does not rotate")
if entered['pressed'] != 'true':
    bad.append(f"the Focus button reads aria-pressed={entered['pressed']!r} in"
               " the mode")
if entered['panelHidden'] is False:
    bad.append("the selection panel is showing in focus mode")

# ---- A CLICK: the mode actually does something
if not focused['sel']:
    bad.append("a focus click selected nothing")
if focused['n'] <= before['n']:
    bad.append(f"a focus click drew no side chains ({focused['n']} positions"
               f" against {before['n']}) - nothing was measured after it")
if focused['panelHidden'] is False:
    bad.append("the selection panel appeared once focus selected something,"
               " which is exactly the case it must not")

# ---- LEAVING: everything back
for key, what in (('sel', 'the selection'), ('clip', 'the slab'),
                  ('zoom', 'the zoom'), ('center', 'the centre')):
    if after[key] != before[key]:
        bad.append(f"{what} did not come back: {before[key]!r} became"
                   f" {after[key]!r}")
# ...and the one that must NOT come back
turned = R.get("turned") or {}
if not turned:
    bad.append("the turn-inside-the-mode leg did not run")
elif turned['rot'] == before['rot']:
    bad.append("the probe did not actually turn the camera inside the mode, so"
               " the assertion below proves nothing")
elif after['rot'] != turned['rot']:
    bad.append("the camera angle the reader set INSIDE focus was undone on the"
               f" way out: {turned['rot']} became {after['rot']} - the mode"
               " gives back what it borrowed, and it never borrowed the angle")
if scOf(after) != scOf(before):
    bad.append(f"the side chains did not come back: {scOf(before)!r} became"
               f" {scOf(after)!r}")
if after['n'] != before['n']:
    bad.append(f"{after['n'] - before['n']:+d} positions survived the mode - the"
               " side chains it drew are still materialised")
if after['pressed'] != 'false':
    bad.append(f"the Focus button reads aria-pressed={after['pressed']!r} after"
               " leaving")
if after['panelHidden'] is not False:
    bad.append("the selection panel did not come back with the selection")

# ---- the mark: an outline while the mode is on, the reader's after it
print(f"  marks    before={before['mark']} entered={entered['mark']}"
      f" after={after['mark']} (dropdown {after['markSel']})")
if before['mark'] != 'highlight':
    bad.append(f"the fixture starts on {before['mark']!r}, so the switch to an"
               " outline below proves nothing")
if entered['mark'] != 'outline':
    bad.append(f"focus did not switch the mark to an outline ({entered['mark']!r})"
               " - the default lays a band OVER the residue the mode just moved"
               " in on")
if entered['markSel'] != 'outline':
    bad.append(f"the Sele dropdown reads {entered['markSel']!r} while the viewer"
               " draws an outline - a control showing something the viewer is"
               " not doing is worse than no control")
if after['mark'] != before['mark']:
    bad.append(f"the mark did not come back: {before['mark']!r} became"
               f" {after['mark']!r}")
cleared, afterCleared = (R.get(k) or {} for k in ("cleared", "afterCleared"))
if not cleared or not afterCleared:
    bad.append("the click-away leg did not run")
else:
    print(f"  cleared  inside={cleared['sel']!r} after leaving={afterCleared['sel']!r}")
    if cleared['sel']:
        bad.append(f"clicking away inside focus re-marked {cleared['sel']!r} -"
                   " that is the selection from BEFORE the mode, and the reader"
                   " has moved on from it")
    if afterCleared['sel'] != '5,6,7,8,9':
        bad.append(f"leaving after a click-away lost the pre-focus selection:"
                   f" {afterCleared['sel']!r} - the mode still borrowed it")

chose, afterChose = (R.get(k) or {} for k in ("chose", "afterChose"))
if not chose or not afterChose:
    bad.append("the reader-picks-a-mark leg did not run")
else:
    print(f"  chosen   inside={chose['mark']} after={afterChose['mark']}")
    if chose['mark'] != 'none':
        bad.append(f"the panel did not change the mark inside focus"
                   f" ({chose['mark']!r})")
    elif afterChose['mark'] != 'none':
        bad.append(f"a mark the reader picked INSIDE focus was undone on the way"
                   f" out ({afterChose['mark']!r}) - focus puts back what it"
                   " borrowed, and it did not borrow that")

bc, ac = (R.get(k) or {} for k in ("beforeClear", "afterClear"))
if not R.get("hasClear"):
    bad.append("the page has no Clear All button, so that leg tested nothing")
elif not bc or not ac:
    bad.append("the Clear All leg did not run")
else:
    print(f"  cleared all: mode={ac['mode']} entry={ac['entry']} pressed={ac['pressed']!r}"
          f" mark={ac['mark']} objects={ac['objects']}")
    if bc['pressed'] != 'true':
        bad.append("the mode was not on when Clear All was pressed, so the leg"
                   " proves nothing")
    if ac['objects']:
        bad.append(f"Clear All left {ac['objects']} object(s)")
    for key, what in (('mode', 'the mode is still on'),
                      ('entry', 'the entry snapshot survived'),
                      ('prev', 'the per-click record survived'),
                      ('busy', 'the busy guard is stuck on'),
                      ('anim', 'a camera flight is still running')):
        if ac[key]:
            bad.append(f"after Clear All, {what} - a fresh structure arrives in"
                       " a mode nobody asked for")
    if ac['pressed'] != 'false':
        bad.append(f"the Focus button still reads aria-pressed={ac['pressed']!r}"
                   " after Clear All")
    want = R.get('markBeforeClearLeg')
    if ac['mark'] != want or ac['markSel'] != want:
        bad.append(f"the mark is {ac['mark']!r} (dropdown {ac['markSel']!r})"
                   f" after Clear All, not the {want!r} the reader had before"
                   " the mode borrowed it. Clear All resets the structure; a"
                   " mark is a preference, and the only thing owed here is what"
                   " focus took")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
