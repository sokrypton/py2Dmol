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

The later legs are about the DOORS the mode did not know it had - every way
the picture can change under a focus while the reader is still in there:

  the sequence strip   BUILDS a selection (click to add, drag for a range) and
                       a canvas click REPLACES. In the mode a strip click
                       moves the focus rather than growing it.
  a load               clears the selection, which the mode reads as the
                       background gesture - and that must not hand back the
                       mark, because leaving one focus is not leaving the mode.
  an object switch     drops the selection while the camera is per object
                       already, so the mode keeps one focus per object and
                       replays it.
  a merge              makes every part of a focus wrong at once - the slab
                       cuts the structure that just arrived - so the focus
                       goes and the mode stays.
  focusOn ALONE        is view.focus() and the embed's v.focus(sel), which
                       never enter the mode. None of the above applies to it.
  Clear All            drops the mode itself: its snapshot names objects that
                       are about to stop existing.
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
        // ...AND ANY POSITION IN A SIDE-CHAIN SET THAT IS NOT A RESIDUE. The
        // frame's own coordinate array is the residue count and does not grow
        // when side chains are materialised; the renderer's does. A search
        // that returns an appended ATOM would file it as a residue to show.
        scPast: (() => {
          const out = [];
          for (const k of Object.keys(r.objectsData || {})) {
            const o = r.objectsData[k];
            const set = o.sidechains;
            const nres = ((o.frames || [])[0] || {}).coords;
            if (!set || !nres) continue;
            for (const i of set) if (i >= nres.length) out.push(k + ':' + i);
          }
          return out;
        })(),
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

      // LEG FIVE: THE SEQUENCE STRIP, AND A LOAD, BOTH INSIDE THE MODE.
      //
      // The strip BUILDS a selection - click to add, click again to take
      // away, drag for a range - and a canvas click in focus mode REPLACES.
      // Toggling against the standing selection made a strip click add to the
      // focus rather than move it, so each click focused the UNION and walked
      // the camera off to the centroid of everything ever clicked.
      //
      // And loading a structure CLEARS the selection, which ui.js reads as the
      // background gesture, which called clearFocus - the way out of one focus
      // and NOT out of the mode - which restored the entry snapshot's mark.
      // Focus stayed lit with the reader's Highlight on the dropdown.
      const dpi = 200 / 96;
      const clickCell = async (idx) => {
        const lay = window.SEQ.layout();
        const cv = document.getElementById('sequenceCanvas');
        const cell = lay.residuePositions.find(
          (rp) => rp.residueData && rp.residueData.positionIndex === idx);
        if (!cell) return 'no strip cell for position ' + idx;
        const bx = cv.getBoundingClientRect();
        const x = bx.left + (cell.x + 2) * bx.width / (cv.width / dpi);
        const y = bx.top + (cell.y + 2 - (lay.scrollTop || 0))
          * bx.height / (cv.height / dpi);
        cv.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: x, clientY: y}));
        window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: x, clientY: y}));
        await settle(); await landed(); await settle();
        return null;
      };
      await until(() => document.getElementById('sequenceCanvas') && window.SEQ
        && window.SEQ.layout() && (window.SEQ.layout().residuePositions || []).length, 20000);
      r.clearResidueSelection();
      await settle();
      // OUTSIDE the mode first, or the leg cannot tell "replaces" from "the
      // strip never adds": two clicks there must give TWO residues.
      R.stripErrA = await clickCell(20);
      R.stripErrB = await clickCell(50);
      R.stripPlain = state().sel;
      r.clearResidueSelection();
      await settle();
      btn.click();                       // enter with nothing selected
      await settle(); await settle();
      R.stripErrC = await clickCell(20);
      R.stripOne = state();
      R.stripErrD = await clickCell(50);
      R.stripTwo = state();
      // ...and now a second structure arrives while the mode is on.
      R.beforeLoad = state();
      await load('1UBQ.cif');
      await settle(); await landed(); await settle();
      R.afterLoad = state();
      R.afterLoad.objects = Object.keys(r.objectsData).length;
      if (r._focusMode) { btn.click(); await settle(); await landed(); await settle(); }

      // LEG SIX: ONE FOCUS PER OBJECT, remembered across a switch.
      //
      // A switch drops the residue selection - the indices belong to the
      // object being left - while the CAMERA is per object already. So
      // leaving a focused object and coming back parked the reader at the
      // pocket they had focused with nothing marked, no side chains and no
      // slab: the camera remembered and nothing else did.
      const names = Object.keys(r.objectsData);
      const settleObj = async (nm) => {
        r._switchToObject(nm); r.setFrame(0);
        await settle(); await landed(); await settle();
      };
      const focusIn = async (nm, i) => {
        await settleObj(nm);
        r.setResidueSelection(new Set([i]));
        await settle(); await landed(); await settle();
      };
      await settleObj(names[0]);
      btn.click();                       // enter, nothing selected
      await settle(); await settle();
      await focusIn(names[0], 20);
      R.focusA = state();
      await focusIn(names[1], 10);
      R.focusB = state();
      await settleObj(names[0]);
      R.recallA = state();
      await settleObj(names[1]);
      R.recallB = state();
      // ...AND A DISMISSED FOCUS STAYS DISMISSED. Clicking the background is
      // a decision; the switch's own clearing of the selection is not, and
      // the two arrive at the same place.
      r.clearResidueSelection();
      await settle(); await landed(); await settle();
      await settleObj(names[0]);
      await settleObj(names[1]);
      R.afterDismiss = state();
      // ...and the memory is the MODE'S: leaving and re-entering forgets it.
      btn.click(); await settle(); await landed(); await settle();
      btn.click(); await settle(); await settle();
      await settleObj(names[0]);
      R.freshMode = state();

      // LEG SEVEN: MERGED, WHERE THE MEMORY MUST NOT EXIST AT ALL. With
      // several objects drawn the switch does NOT drop the selection - the
      // indices are the merged array's and mean the same thing whichever
      // object is being edited - and the strip sets the edited object from
      // where you clicked. So a recall would replace the selection that ASKED
      // for the switch, which is what that branch exists to protect.
      // ...AND THE MEMORY IS WRITTEN FIRST, WHILE STILL SINGLE, because that
      // is the case only the RECALL guard covers: a set stored in one
      // object's own numbering, then Multi turned on, where the same numbers
      // are merged indices naming a different residue.
      // ...AGAINST THE MODE'S OWN BASELINE, not against nothing. A focus
      // dropped inside the mode restores what the mode FOUND - this probe has
      // been at it for six legs and enters with side chains and a slab
      // already there, which the mode is obliged to give back.
      R.modeBaseline = state();
      await focusIn(names[0], 20);
      await settleObj(names[1]);          // stores 20 against the first object
      await focusIn(names[1], 10);
      if (r.setShownObjects) r.setShownObjects(names.slice());
      await settle(); await landed(); await settle();
      R.mergedOn = !!((r.multiState && r.multiState.enabled)
        || (r._mergeWanted && r._mergeWanted()));
      // 🔴 TURNING MULTI ON MID-FOCUS CLEARS THE FOCUS. A focus is a
      // NEIGHBOURHOOD measured against the picture it was made in: the slab
      // is cut to one residue's depth and would slice through the structure
      // that has just arrived, and the camera sits in a pocket that is now a
      // corner of a bigger scene. The mode stays on; this focus does not.
      R.mergedCleared = state();
      r.setResidueSelection(new Set([40]));
      await settle(); await landed(); await settle();
      await settleObj(names[0]);          // the switch the strip makes
      R.mergedBack = state();
      if (r.setShownObjects) r.setShownObjects([names[0]]);
      await settle(); await landed(); await settle();
      if (r._focusMode) { btn.click(); await settle(); await landed(); await settle(); }

      // LEG EIGHT: THE API'S focusOn, WHICH IS NOT THE MODE. view.focus() and
      // the embed's v.focus(sel) call focusOn directly and never set
      // _focusMode - so the clear above, which is guarded on that flag, must
      // not touch them. `view.focus(...)` then `view.show_objects([...])` is
      // two instructions and both were asked for; the mode's clear is about a
      // reader whose PICTURE changed under a focus they made by clicking.
      if (r._focusMode) { btn.click(); await settle(); await landed(); await settle(); }
      await settleObj(names[0]);
      r.focusOn(new Set([20]));
      await settle(); await landed(); await settle();
      R.apiFocus = state();
      if (r.setShownObjects) r.setShownObjects(names.slice());
      await settle(); await landed(); await settle();
      R.apiAfterMerge = state();
      r.clearFocus(false);
      if (r.setShownObjects) r.setShownObjects([names[0]]);
      await settle(); await landed(); await settle();

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
      // 🔴 AND MOVING FROM ONE FOCUS TO THE NEXT DOES NOT STEP THE ZOOM.
      //
      // focusMoveTo lerps the centre and the extent and used to SNAP the
      // aspect, on the reasoning that the shape belongs to the target and
      // lerping it would make the picture breathe sideways. Nothing here
      // scales anisotropically: the aspect only decides which side of the
      // viewport binds, and what comes out is one isotropic scale. So the snap
      // was a step in the ZOOM, and every click lands on a neighbourhood of a
      // different shape - measured at 44% and 32% of the whole change in a
      // single frame, against 10-13% once it is interpolated, which is what
      // the easing's own steepest frame is worth over a flight this length.
      //
      // A WIDE BOX, because on a near-square canvas the same side binds
      // whatever the aspect is and the snap cannot be seen at all.
      {
        // ...A STRUCTURE FIRST. This runs after the Clear All leg, which is
        // exactly what it says it is: there is nothing on screen by then, and
        // measuring a zoom on an empty viewer reports 0 positions.
        await load('1UBQ.cif');
        await until(loaded);
        await settle(4);
        const holder = document.getElementById('canvasContainer');
        const wasStyle = holder.getAttribute('style') || '';
        holder.style.width = '560px'; holder.style.height = '300px';
        window.dispatchEvent(new Event('resize'));
        await settle(8);
        const worst = [];
        // ...WINDOWS TAKEN FROM THE STRUCTURE, not written out: this probe is
        // run against whichever file it is given (4HHB by default, 1UBQ part
        // way through), and fixed indices past the end of a small one leave
        // the check with nothing to measure and no way to say so.
        const N = (r.coords && r.coords.length) || 0;
        R.focusZoomN = N;
        const windows = [[0.15, 6], [0.45, 3], [0.70, 8]].map(([at, len]) => {
          const start = Math.floor(N * at);
          const out = [];
          for (let i = start; i < start + len && i < N; i++) out.push(i);
          return out;
        });
        for (const set of windows) {
          const usable = set.filter((i) => i < r.coords.length);
          if (usable.length < 2) continue;
          const seen = [];
          let sampling = true;
          const tick = () => {
            if (!sampling) return;
            seen.push(r._viewScale || 0);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          r.focusOn(new Set(usable));
          await new Promise((done) => setTimeout(done, 900));
          sampling = false;
          let end = seen.length - 1;
          while (end > 1 && seen[end] === seen[end - 1]) end--;
          const f = seen.slice(0, end + 1);
          let mx = 0;
          for (let i = 1; i < f.length; i++) mx = Math.max(mx, Math.abs(f[i] - f[i - 1]));
          const span = Math.abs(f[f.length - 1] - f[0]);
          worst.push({n: usable.length, frames: f.length, span: +span.toFixed(3),
            maxStep: +mx.toFixed(3), frac: span > 0.05 ? +(mx / span).toFixed(2) : null});
          await new Promise((done) => setTimeout(done, 300));
        }
        R.focusZoom = worst;
        // 🔴 AND THE MAGNIFICATION MUST NOT SWING ON THE SHAPE OF THE BLOB.
        // The extent is floored so every focused residue is drawn at the same
        // size; the aspect was measured raw from the neighbourhood, which at
        // that size is noise, and it feeds the same single scale. Clicking
        // from one side chain to the next gave (0.431, 1), (1, 0.861),
        // (1, 0.874) and swung the zoom 10-15% each time - reported as zooming
        // in, moving, and zooming back out.
        //
        // THE INVARIANT IS scale x extent, not the scale: neighbourhoods
        // genuinely differ in size and a bigger one SHOULD draw smaller. What
        // must not vary is the rest of it.
        // ONE RESIDUE AT A TIME, which is the gesture reported: a click on a
        // side chain. focusOn expands it to the neighbourhood, and those come
        // out near the floor in every direction, so the shape is noise and the
        // magnification should not move. A RUN of residues is a different
        // thing - a chain segment really is elongated - and is not measured
        // here for that reason.
        const products = [];
        for (const at of [0.15, 0.45, 0.70, 0.30]) {
          const i = Math.floor(N * at);
          if (i >= N) continue;
          r.focusOn(new Set([i]));
          await new Promise((done) => setTimeout(done, 800));
          products.push({at: i, ext: +r.viewerState.extent.toFixed(2),
            product: +r._viewScale.toFixed(2)});
        }
        R.focusProducts = products;
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
# ...WITH ITS OWN BUDGET. Six legs, two structures and a dozen camera flights
# to wait out: 15 s alone against the shared 30, which the parallel UI lane
# doubles often enough to fail as "no result posted" - a timeout wearing a
# crash's clothes. The legs are the point, so the budget moves.
end = time.time() + DEADLINE * 2
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

for k in ("stripErrA", "stripErrB", "stripErrC", "stripErrD"):
    if R.get(k):
        bad.append(f"{k}: {R[k]}")
plain, one, two = (R.get(k) or {} for k in ("stripPlain", "stripOne", "stripTwo"))
if isinstance(plain, dict):
    plain = plain.get("sel")
if plain is None or not one or not two:
    bad.append("the sequence-strip leg did not run")
else:
    print(f"  strip    outside={plain!r} in focus: {one['sel']!r} then"
          f" {two['sel']!r} (side chains {one['sc']} -> {two['sc']})")
    if plain != '20,50':
        bad.append(f"outside the mode two strip clicks left {plain!r}, not"
                   " '20,50' - the strip BUILDS a selection, and if it stopped"
                   " doing that the focus leg below proves nothing")
    if one['sel'] != '20':
        bad.append(f"a strip click in focus mode selected {one['sel']!r}")
    if two['sel'] != '50':
        bad.append(f"a second strip click left {two['sel']!r}, not '50' - in"
                   " focus mode a click REPLACES, the way a canvas click does."
                   " Toggling against the standing selection focuses the UNION"
                   " and walks the camera to the centroid of every residue"
                   " ever clicked")
    flat = lambda st: {f"{k}:{p}" for k, v in (st.get('sc') or {}).items()
                       for p in str(v).split(',') if p}
    kept = flat(one) & flat(two)
    if kept:
        bad.append(f"{len(kept)} of the first click's side chains are still"
                   f" out after the second ({sorted(kept)[:6]}): residues 20"
                   " and 50 of 4HHB are nowhere near each other, so the"
                   " neighbourhoods are piling up rather than replacing")

bl, al = (R.get(k) or {} for k in ("beforeLoad", "afterLoad"))
if not bl or not al:
    bad.append("the load-inside-the-mode leg did not run")
else:
    print(f"  loaded   {al.get('objects')} objects, mode still on:"
          f" pressed={al['pressed']!r} mark={al['mark']} (dropdown {al['markSel']!r})")
    if bl['pressed'] != 'true' or bl['mark'] != 'outline':
        bad.append("the mode was not on and wearing its outline before the"
                   " load, so that leg proves nothing")
    if (al.get('objects') or 0) < 2:
        bad.append("the second structure did not load")
    if al['pressed'] != 'true':
        bad.append("loading a structure turned the mode off but left the"
                   " snapshot - either it is a mode or it is not")
    elif al['mark'] != 'outline' or al['markSel'] != 'outline':
        bad.append(f"the mode is still on and the mark went to {al['mark']!r}"
                   f" (dropdown {al['markSel']!r}). A load clears the"
                   " selection, ui.js reads that as the background gesture,"
                   " and clearFocus is the way out of one FOCUS - not out of"
                   " the mode, so it must not hand the mark back yet")

fa, fb, ra, rb = (R.get(k) or {} for k in ("focusA", "focusB", "recallA", "recallB"))
ad, fm = (R.get(k) or {} for k in ("afterDismiss", "freshMode"))
if not fa or not rb:
    bad.append("the per-object memory leg did not run")
else:
    print(f"  per object  focused {fa['sel']!r} then {fb['sel']!r};"
          f" back: {ra['sel']!r} / {rb['sel']!r}; dismissed -> {ad['sel']!r};"
          f" fresh mode -> {fm['sel']!r}")
    if fa['sel'] != '20' or fb['sel'] != '10':
        bad.append(f"the two focuses came out {fa['sel']!r} and {fb['sel']!r}"
                   " - the leg cannot test a memory it never wrote")
    if ra['sel'] != '20':
        bad.append(f"switching back left {ra['sel']!r}, not '20'. The camera is"
                   " per object already, so dropping the selection alone parks"
                   " a returning reader at the pocket they focused with nothing"
                   " marked and no side chains")
    elif not ra['sc'] or not ra['clipOn']:
        bad.append(f"the selection came back but the neighbourhood did not"
                   f" (side chains {ra['sc']}, slab {ra['clipOn']}) - a focus is"
                   " all four things or it is a highlight")
    if rb['sel'] != '10':
        bad.append(f"the other object came back as {rb['sel']!r}, not '10' -"
                   " the memory is per object, not one slot")
    if ad['sel']:
        bad.append(f"a focus dismissed with a background click came back as"
                   f" {ad['sel']!r} after a switch. What is remembered is"
                   " whatever is focused at the moment of the switch, so an"
                   " empty selection has to CLEAR that object's slot rather"
                   " than leave the last one in it")
    if fm['sel']:
        bad.append(f"a fresh mode opened already focused on {fm['sel']!r} - the"
                   " memory belongs to the mode and dies with it")

mb = R.get("mergedBack") or {}
if not mb:
    bad.append("the merged leg did not run")
else:
    mc0 = R.get('mergedCleared') or {}
    print(f"  merged      Multi on mid-focus drops the focus back to the"
          f" mode's baseline (sel {mc0.get('sel')!r}, still in mode"
          f" {mc0.get('pressed')!r}); after the switch: {mb['sel']!r}")
    if not R.get("mergedOn"):
        bad.append("the objects did not merge, so that leg tested the"
                   " single-object path twice")
    elif (mc := R.get('mergedCleared') or {}) and (
            mc['sel'] or mc['sc'] != (R.get('modeBaseline') or {}).get('sc')):
        bad.append(f"turning Multi on mid-focus left the focus behind:"
                   f" selection {mc['sel']!r}, side chains {mc['sc']} against"
                   f" the mode's baseline {(R.get('modeBaseline') or {}).get('sc')}")
    elif mc['clipOn']:
        # 🔴 AND THE SLAB GOES RATHER THAN COMING BACK. It is a near and a far
        # along the view, measured on the picture that was there when the mode
        # was entered - put back onto a different set of objects it cuts
        # somewhere arbitrary and can take the whole structure with it. The
        # camera has the same fault and is WIDENED to fit; a slab has no
        # equivalent, so it is dropped, and the Clip button follows it off so
        # nothing is silently wrong. What the mode gives back is what it
        # borrowed, and a slab it never touched stops being about anything
        # once the picture changes.
        bad.append("the slab survived a change of what is drawn - it was cut"
                   " to a depth on the old picture and now cuts the new one"
                   " somewhere arbitrary")
    elif (R.get('mergedCleared') or {}).get('pressed') != 'true':
        bad.append("turning Multi on left the MODE as well - the reader did"
                   " not press Focus, and the next click should still focus")
    elif mb['sel'] != '40':
        bad.append(f"a merged switch left {mb['sel']!r}, not the '40' that was"
                   " selected just before it. Merged, the switch keeps the"
                   " selection - the indices mean the same thing whichever"
                   " object is edited, and the strip switches the edited object"
                   " FROM a click - so the per-object memory must not exist"
                   " there at all")

bc, ac = (R.get(k) or {} for k in ("beforeClear", "afterClear"))
af, am = (R.get(k) or {} for k in ("apiFocus", "apiAfterMerge"))
if not af or not am:
    bad.append("the API-focus leg did not run")
else:
    print(f"  api focus   without the mode: sel {af['sel']!r} sc {af['sc']};"
          f" after a merge: sel {am['sel']!r} sc {am['sc']}")
    if af['pressed'] == 'true' or am['pressed'] == 'true':
        bad.append("that leg entered the MODE, so it is not testing focusOn")
    if not af['sel'] or not af['sc']:
        bad.append(f"focusOn on its own drew nothing ({af['sel']!r},"
                   f" {af['sc']}), so the leg cannot see it survive")
    elif (am['sel'] != af['sel'] or am['sc'] != af['sc']
          or am['clipOn'] != af['clipOn']):
        bad.append(f"a focus made through the API did not survive a merge:"
                   f" {af['sel']!r}/{af['sc']} became {am['sel']!r}/{am['sc']}."
                   " view.focus() then view.show_objects() is two instructions"
                   " and both were asked for - the mode's clear is guarded on"
                   " _focusMode for exactly this reason")

past = sorted({p for k in ("focusA", "focusB", "recallA", "recallB",
                             "mergedCleared", "afterChose", "after")
               for p in ((R.get(k) or {}).get("scPast") or [])})
if past:
    bad.append(f"a side-chain set holds {past}, which is past the last residue"
               " - showing side chains APPENDS their atoms as positions, and a"
               " neighbourhood search that returns one files an ATOM as a"
               " residue. A side-chain atom is its residue, the same rule"
               " _wholeThingAt applies to a click")

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

fz = R.get("focusZoom") or []
print("  focus zoom, biggest single-frame step as a share of the move:")
for c in fz:
    print(f"    {c['n']} residues: {c['frames']} frames, span {c['span']},"
          f" step {c['maxStep']} ({c['frac']})")
moved = [c for c in fz if (c.get("span") or 0) > 0.5]
if not moved:
    bad.append(f"no focus move changed the zoom enough to see a step in it"
               f" ({R.get('focusZoomN')} positions, {len(fz)} moves measured),"
               " so the check below would pass against a snap")
for c in moved:
    if (c.get("frac") or 0) > 0.25:
        bad.append(f"a focus move carried {c['maxStep']} of a {c['span']} zoom"
                   " change in one frame - focusMoveTo lerps the extent and"
                   " snaps the aspect, and both feed the same single scale, so"
                   " every click on a neighbourhood of a different shape steps")

pr = R.get("focusProducts") or []
print("  focus on single residues, magnification:"
      f" {[p['product'] for p in pr]} (extents {[p['ext'] for p in pr]})")
vals = [p["product"] for p in pr]
if len(vals) < 2:
    bad.append("fewer than two single-residue focuses measured, so a swinging"
               " magnification would go unreported")
elif max(vals) - min(vals) > 0.02 * max(vals):
    bad.append(f"clicking from one residue to the next changes the"
               f" magnification: it came out {vals}, and it should be one"
               " number. THE SCALE ITSELF, not scale x extent: the half-spans"
               " are floored to the same number, so every focused residue is"
               " fitted to the same box whatever its 3D radius says - which is"
               " what the floor is for. The aspect is measured from the blob"
               " and is noise at this size, so without the same floor on it"
               " the zoom swings on every click")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
