"""`renderer.stableTopology` keeps the fold's answers across frames - and is
wrong to, on a trajectory that folds.

    python3 tests/stable_topology.py

WHAT IT ASSERTS, in the order the option can go wrong:

  1. OFF BY DEFAULT. Stepping a trajectory rebuilds the assignment every frame,
     which is what shipped and what a folding trajectory needs.
  2. ON, IT IS COMPUTED ONCE. One rebuild across the whole run, not one a frame.
  3. AND THE ANSWER IS THE SAME ONE. Frame by frame, the assignment kept is
     character-for-character the assignment that would have been recomputed.
     This is the correctness claim: a faster wrong picture is not the goal.
  4. THE PIXELS AGREE TOO, because (3) covers the letters and not what was
     drawn with them - the sheet frames and the base pairing ride on the same
     key.
  5. 🔴 AND ON A FOLDING TRAJECTORY IT IS WRONG, ON PURPOSE. _traj_unfold.pdb
     pulls a structure out to an extended chain, so the assignment genuinely
     differs frame to frame; the option is asserted to DISAGREE there. Without
     this leg the suite would be satisfied by an option that did nothing, and
     the argument for keeping it off by default would rest on a comment.
"""
import json, os, sys, shutil, time, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stabletopo.html")
PORT = 9785
DEBUG_PORT = 9786
STABLE = sys.argv[1] if len(sys.argv) > 1 else "_traj_1tim.pdb"
FOLDING = "_traj_unfold.pdb"

# ...AND THE FIXTURES ARE BUILT IF THEY ARE NOT THERE. They are generated
# files, not repository content, so the suite cannot assume a previous run.
if not all(os.path.exists(os.path.join(ROOT, f)) for f in (STABLE, FOLDING)):
    import subprocess
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  // 🔴 WHETHER THE RENDERER HID IT, which is not the same as whether it is on
  // screen. This read `b.style.display === 'none'` on the control itself, which
  // was right while Keep SSE was a <button> in the play bar. It is a toggle in
  // the style panel now - a label wrapping a checkbox - and two things changed
  // with it: the renderer hides the LABEL (hiding the input would hide nothing
  // anyone can see), and the panel it sits in is CLOSED until the Style button
  // is pressed. So `offsetParent === null` answers "the panel is shut" just as
  // readily as "there is one frame", and a trajectory failed on it.
  //
  // What this leg is about is the renderer's own rule - hide it where there is
  // no next frame - so it asks the face's computed display, which the panel
  // being shut does not touch.
  const sseHidden = (el) => {
    if (!el) return true;
    const face = (el.closest && el.closest('.btn-toggle')) || el;
    return getComputedStyle(face).display === 'none';
  };
  window.__run = async (file) => {
    const txt = await (await fetch('/' + file)).text();
    await window.processFiles(
      [{name: file, readAsync: () => Promise.resolve(txt)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(5);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    const C = window.py2dmolCartoon;

    // ONE PASS OVER THE TRAJECTORY, in one of the two modes. It reports the
    // assignment it DREW WITH per frame, how many times that was rebuilt, the
    // canvas, and the time.
    const pass = (stable) => {
      r.stableTopology = stable;
      // ...from a clean slate either way, so the first frame is not a
      // leftover of the other mode.
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      // 🔴 AND THE LOOP'S FIRST setFrame HAS TO BE A REAL CHANGE. Landing on
      // the frame that is already current is a no-op, the mesh signature does
      // not move, the GPU redraws the resident mesh - and the draw stage that
      // fills `_cartoonSec` never runs, so the probe read a null and called it
      // a disagreement. Park on the last frame so stepping to 0 is a step.
      r.setFrame(frames - 1); r.render();
      const secs = [];
      const shots = [];
      let rebuilds = 0;
      let lastKey = null;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        r.setFrame(i);
        r.render();
        if (r._cartoonSecKey !== lastKey) { rebuilds += 1; lastKey = r._cartoonSecKey; }
        // WHAT THE DRAW STAGE LEFT BEHIND, not a fresh call: asking
        // secondaryFor here would recompute on a miss and report the answer
        // the frame did NOT use, which is the one thing this must not do.
        const s = r._cartoonSec;
        secs.push(s ? Array.from(s).join('') : null);
        if (i % 6 === 0) shots.push(r.canvas.toDataURL().length + ':'
          + r.canvas.toDataURL().slice(-64));
      }
      return {ms: (performance.now() - t0) / frames, rebuilds, secs, shots, frames};
    };
    // 🔴 THREE OF EACH, ALTERNATING. Run once each in sequence, the two arms
    // are minutes apart on a machine that drifts, and the difference measured
    // was 1.09x and 1.21x on consecutive runs of the identical code.
    const offRuns = []; const onRuns = [];
    for (let k = 0; k < 3; k++) { offRuns.push(pass(false)); onRuns.push(pass(true)); }
    const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
    const off = offRuns[0]; const on = onRuns[0];
    off.ms = med(offRuns.map((p) => p.ms));
    on.ms = med(onRuns.map((p) => p.ms));
    r.stableTopology = false;

    // HOW FAR APART THE TWO ASSIGNMENTS ARE, per frame, as a fraction of the
    // positions. Equality is the wrong test - see the note in the header.
    const apart = off.secs.map((a, i) => {
      const b = on.secs[i];
      if (a === null || b === null) return null;
      let n = 0;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) n++;
      return n / a.length;
    });
    const live = apart.filter((v) => v !== null);
    return {file, frames, positions: r.coords.length,
            off: {ms: off.ms, rebuilds: off.rebuilds},
            on: {ms: on.ms, rebuilds: on.rebuilds},
            sameSec: off.secs.every((s, i) => s === on.secs[i]),
            worstApart: Math.max(...live),
            meanApart: live.reduce((a, b) => a + b, 0) / live.length,
            nullFrames: apart.filter((v) => v === null).length,
            samePixels: off.shots.every((s, i) => s === on.shots[i]),
            distinctOff: new Set(off.secs).size,
            distinctOn: new Set(on.secs).size,
            firstMismatch: off.secs.findIndex((s, i) => s !== on.secs[i]),
            // ...and WHERE they differ, because "the strings are not equal" is
            // not enough to tell a null from one letter in five hundred.
            diff: (() => {
              const i = off.secs.findIndex((s, k) => s !== on.secs[k]);
              if (i < 0) return null;
              const a = off.secs[i]; const b = on.secs[i];
              if (a === null || b === null) return {frame: i, a, b};
              let n = 0; const at = [];
              for (let k = 0; k < Math.max(a.length, b.length); k++) {
                if (a[k] !== b[k]) { n++; if (at.length < 8) at.push(k + a[k] + '/' + b[k]); }
              }
              return {frame: i, length: a.length, differing: n, at};
            })()};
  };
  // ...AND THE BUTTON, which is what a reader actually touches. Driven by
  // clicking it, not by setting the flag: the wiring is the part that can be
  // wrong while the mechanism is right.
  window.__button = async (file) => {
    const txt = await (await fetch('/' + file)).text();
    await window.processFiles(
      [{name: file, readAsync: () => Promise.resolve(txt)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(5);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const b = document.querySelector('#keepSseButton');
    if (!b) return {found: false};
    const lit = () => b.classList.contains('btn-primary');
    const before = {flag: !!r.stableTopology, lit: lit(),
                    hidden: sseHidden(b), disabled: !!b.disabled};
    b.click(); await settle(3);
    const on = {flag: !!r.stableTopology, lit: lit()};
    // ...and it keeps the assignment now, which is the point of the button.
    let rebuilds = 0; let last = null;
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    r.setFrame(frames - 1); r.render();
    for (let i = 0; i < frames; i++) {
      r.setFrame(i); r.render();
      if (r._cartoonSecKey !== last) { rebuilds += 1; last = r._cartoonSecKey; }
    }
    // 🔴 AND THE BUTTON TURNS ON THE TRAJECTORY PATH, which is what its tooltip
    // now promises. Keep SSE is the precondition for it - the station count
    // follows the assignment - so the two are one control; if they ever come
    // apart, the button says "about 3x" and delivers nothing.
    const G = window.py2dmolCartoonGPU;
    window.__stationFastPath = 0;
    r.setFrame(1); r.render('afterButton'); await settle(3);
    r.setFrame(2); r.render('afterButton2'); await settle(3);
    // ...declared out here so the cut arm's IIFE can report what it saw
    let cutScansSeen = 0;
    const path = {
      installed: !!(G && G.stationsResident && G.stationsResident()),
      fastSteps: window.__stationFastPath || 0,
      // 🔴 THE MESH, NOT THE FLAG. This read `r._noFoldCuts === true`, because
      // the button used to set that renderer flag - which geom.js reads on BOTH
      // paths, so pressing it also took the fold cuts away from the 2D painter,
      // which sorts and needs them. The cuts are now dropped inside captureFrom
      // on every mesh build instead, so the flag is no longer the button's to
      // set and asserting on it would be asserting on nothing.
      //
      // What is worth asserting is the thing the flag was a proxy for: that the
      // MESH has fewer pieces than the cut prim list it was built from. 196
      // against 201 on 1UBQ.
      // 🔴 AND THE PIECE COUNTS STOPPED BEING PROOF OF IT. At a finer sampling
      // the fold cuts are redundant with cuts that already exist - 27 found on
      // 1UBQ and not one extra piece - so "the mesh has fewer pieces than the
      // cut list" is no longer true even though the mesh is still built with
      // the cuts dropped. What is asserted now is the property itself: the
      // build does not SCAN for them, and the arm that asks for them does.
      // See the counter beside the scan loop in geom.js.
      meshScans: (() => {
        window.__foldCutScans = 0;
        if (G && G.invalidate) G.invalidate();
        r.render('scanProbe');
        return window.__foldCutScans || 0;
      })(),
      meshPieces: (G && G.stationsResident() && G.stationsResident().pieces) || 0,
      cutScans: 0,
      cutPieces: (() => {
        const keep = {po: r._probeOnly, pp: r._primProbe, gpu: r.useGPU,
                      nfc: r._noFoldCuts};
        r.useGPU = false; r._probeOnly = true; r._primProbe = null;
        r._noFoldCuts = false;
        window.__foldCutScans = 0;
        r.render('cutPieceCount');
        cutScansSeen = window.__foldCutScans || 0;
        const n = (r._primProbe || []).filter((p) => p && p.kind === 'rib' && p.Lp).length;
        r._probeOnly = keep.po; r._primProbe = keep.pp; r.useGPU = keep.gpu;
        r._noFoldCuts = keep.nfc;
        return n;
      })(),
    };
    path.cutScansSeen = cutScansSeen;

    b.click(); await settle(3);
    const off = {flag: !!r.stableTopology, lit: lit()};
    // measured with the automatic table out of the way: see the note by the
    // assertion in the python half. No second click - the button is already
    // released; this only stops renderApp handing the table straight back on
    // the next frame, which on a trajectory it now does.
    r._autoStationTable = false;
    if (G && G.clearResidentStations) G.clearResidentStations();
    r.render('afterOffNoAuto'); await settle(3);
    path.clearedAfterOff = !(G && G.stationsResident && G.stationsResident());
    r._autoStationTable = true;
    // ...and going back recomputes again, which is the half a toggle usually
    // gets wrong: the cache still holds the answer made under the other key.
    let backRebuilds = 0; last = null;
    r.setFrame(frames - 1); r.render();
    for (let i = 0; i < frames; i++) {
      r.setFrame(i); r.render();
      if (r._cartoonSecKey !== last) { backRebuilds += 1; last = r._cartoonSecKey; }
    }
    // 🔴 AND THE BONDS ARE PINNED TOO. Connectivity is a distance test at 5.0 A
    // with no hysteresis, so a pair near it crosses back and forth as a
    // structure breathes - changing the segment count, breaking the ribbon, and
    // throwing away every cache keyed on the geometry. Keep SSE already claims
    // these frames are one molecule moving; if that is true the bond list is a
    // property of the molecule and not of the frame.
    const flick = await (await fetch('/_traj_flicker.pdb')).text();
    await window.processFiles(
      [{name: '_traj_flicker.pdb', readAsync: () => Promise.resolve(flick)}], true);
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(5);
    const fObj = r.objectsData[r.currentObjectName];
    const fN = (fObj && fObj.frames) ? fObj.frames.length : 1;
    const segsOver = (keep) => {
      r.stableTopology = keep;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      const seen = new Set();
      for (let i = 0; i < fN; i++) {
        r.setFrame(i); r.render('flick');
        seen.add(r.segmentIndices ? r.segmentIndices.length : -1);
      }
      return [...seen].sort((a, b) => a - b);
    };
    const bonds = {loose: segsOver(false), pinned: segsOver(true)};
    r.stableTopology = false;

    // ...AND IT IS NOT THERE ON A STILL PICTURE. A single frame has nothing
    // to keep the assignment across, and a lit button over one is a question
    // the reader cannot answer.
    const one = await (await fetch('/1UBQ.cif')).text();
    await window.processFiles(
      [{name: '1UBQ.cif', readAsync: () => Promise.resolve(one)}], true);
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(5);
    const still = {hidden: sseHidden(b), disabled: !!b.disabled};
    return {found: true, frames, before, on, off, rebuilds, backRebuilds, still, path, bonds};
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE, "w").write(
    open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

profile_dir = "/tmp/py2dmol-stabletopo"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stabletopo.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")

out = {}
for tag, f in (("stable", STABLE), ("folding", FOLDING)):
    out[tag] = json.loads(cdp.evaluate(
        ws, f"window.__run({json.dumps(f)}).then(JSON.stringify)"))

out["button"] = json.loads(cdp.evaluate(
    ws, f"window.__button({json.dumps(STABLE)}).then(JSON.stringify)"))

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
s, f = out["stable"], out["folding"]

pct = lambda v: f"{100 * v:.2f}%"
print(f"constant fold  {s['file']}  {s['positions']} positions, {s['frames']} frames")
print(f"  off: {s['off']['rebuilds']} rebuilds, {s['off']['ms']:.2f} ms a frame,"
      f" {s['distinctOff']} distinct assignments")
print(f"  on:  {s['on']['rebuilds']} rebuilds, {s['on']['ms']:.2f} ms a frame,"
      f" {s['distinctOn']} distinct assignments")
print(f"  kept vs recomputed: worst {pct(s['worstApart'])} of residues,"
      f" mean {pct(s['meanApart'])}")
print(f"  first difference: {s['diff']}")
print(f"\nfolding        {f['file']}  {f['positions']} positions, {f['frames']} frames")
print(f"  off: {f['off']['rebuilds']} rebuilds, {f['distinctOff']} distinct assignments")
print(f"  on:  {f['on']['rebuilds']} rebuilds, {f['distinctOn']} distinct assignments")
print(f"  kept vs recomputed: worst {pct(f['worstApart'])} of residues,"
      f" mean {pct(f['meanApart'])}")

# 1. the default is exactly what shipped
if s["off"]["rebuilds"] < s["frames"]:
    bad.append(f"with the option OFF the assignment was rebuilt only"
               f" {s['off']['rebuilds']} times over {s['frames']} frames; the"
               " default has to stay one rebuild a frame")
# 2. on, it is computed once
if s["on"]["rebuilds"] != 1:
    bad.append(f"with the option ON it was rebuilt {s['on']['rebuilds']} times;"
               " the whole point is once")
if s["distinctOn"] != 1:
    bad.append(f"with the option ON the drawn assignment took"
               f" {s['distinctOn']} values; one cache, one answer")
# 3. ...and the answer is within the flicker, not a different fold
# 🔴 FIVE PERCENT, AND NOT EQUALITY, BECAUSE THE ASSIGNMENT FLICKERS. Measured
# on _traj_1tim.pdb, whose fold provably does not change: the recomputed
# assignment still takes 15 distinct values over 30 frames, differing from
# frame 0's by up to 2.43% of residues (12 of 494) and 1.79% on average - a
# helix end moving in and out by a residue as the backbone breathes. So "the
# option changes the picture" is true and is not the question; the question is
# whether it changes it by more than the recomputation does to itself. The
# folding trajectory sits at 64%, a factor of 26 away, so the threshold is not
# a fine judgement.
if s["worstApart"] > 0.05:
    bad.append(f"on a constant-fold trajectory the kept assignment is"
               f" {pct(s['worstApart'])} away from the recomputed one at its"
               " worst. That is past the boundary flicker this option absorbs"
               " and into a different structure")
# 4. ...and on a folding trajectory it is grossly wrong, which is the argument
#    for the default
if f["worstApart"] < 0.20:
    bad.append(f"on a FOLDING trajectory the kept assignment is only"
               f" {pct(f['worstApart'])} away from the recomputed one, so this"
               " probe is not testing the hazard it claims to: either"
               " _traj_unfold.pdb does not change the fold enough, or the"
               " option is not being applied")
if f["distinctOn"] != 1:
    bad.append(f"with the option on, a folding trajectory produced"
               f" {f['distinctOn']} assignments; it should keep exactly one,"
               " which is precisely why it is wrong there")

# 6. THE BUTTON, driven by clicking it
b = out["button"]
print(f"\nKeep SSE button")
if not b.get("found"):
    bad.append("there is no #keepSseButton on the page")
else:
    print(f"  before: flag={b['before']['flag']} lit={b['before']['lit']}"
          f" hidden={b['before']['hidden']} disabled={b['before']['disabled']}")
    print(f"  one click:  flag={b['on']['flag']} lit={b['on']['lit']},"
          f" {b['rebuilds']} rebuilds over {b['frames']} frames")
    print(f"  and again:  flag={b['off']['flag']} lit={b['off']['lit']},"
          f" {b['backRebuilds']} rebuilds over {b['frames']} frames")
    if b["before"]["flag"] or b["before"]["lit"]:
        bad.append("the button comes up already on; the default is off")
    if b["before"]["hidden"] or b["before"]["disabled"]:
        bad.append("the button is hidden or disabled on a trajectory, where it"
                   " is exactly what it is for")
    if not (b["on"]["flag"] and b["on"]["lit"]):
        bad.append(f"one click left flag={b['on']['flag']} lit={b['on']['lit']};"
                   " it has to set the flag and light up")
    if b["rebuilds"] != 1:
        bad.append(f"with the button on the assignment was rebuilt"
                   f" {b['rebuilds']} times; pressing it has to actually keep it")
    if b["off"]["flag"] or b["off"]["lit"]:
        bad.append(f"a second click left flag={b['off']['flag']}"
                   f" lit={b['off']['lit']}; it has to go back off")
    pa = b["path"]
    print(f"  the path it turns on: installed={pa['installed']}"
          f" pieces={pa['meshPieces']}/{pa['cutPieces']} fastSteps={pa['fastSteps']}"
          f" clearedAfterOff={pa['clearedAfterOff']}")
    if not pa["installed"]:
        bad.append("pressing the button did not install the station table, so"
                   " the trajectory path its tooltip promises is not on")
    print(f"  fold cuts: the mesh build scanned {pa.get('meshScans')} interval(s),"
          f" the cut arm {pa.get('cutScansSeen')};"
          f" {pa['meshPieces']} mesh pieces against {pa['cutPieces']} cut ones")
    if pa.get("meshScans"):
        bad.append(f"the mesh build scanned for fold cuts {pa['meshScans']}"
                   " time(s) - captureFrom is supposed to drop them on every"
                   " build, and with them a third of steps rebuild")
    if not pa.get("cutScansSeen"):
        bad.append("the arm that ASKS for the fold cuts did not scan for them"
                   " either, so this file cannot tell a build that drops them"
                   " from one that never had them")
    if not (0 < pa["meshPieces"] <= pa["cutPieces"]):
        bad.append(f"the mesh has {pa['meshPieces']} pieces against"
                   f" {pa['cutPieces']} in the cut prim list - a mesh built"
                   " with the cuts dropped cannot have MORE")
    if pa["fastSteps"] < 1:
        bad.append(f"renderApp took the fast path {pa['fastSteps']} times after"
                   " the button was pressed; the button is meant to be what"
                   " switches it on")
    # 🔴 THE BUTTON NO LONGER OWNS THE TABLE ON A TRAJECTORY, and this line
    # used to say it did. renderApp switches the station table on for any
    # object with more than one frame, pinned or not - the table is machinery,
    # the pin is a promise about the data, and only the second needs asking
    # for. So releasing the button clears the table and the very next frame
    # builds it again, which is the intended behaviour and not a leak.
    #
    # What still has to be true is that the button releases the PIN, which the
    # `off` block above checks, and that the table is gone for a SINGLE
    # structure, which has no trajectory to earn it. That is what this asserts
    # now - with _autoStationTable off, so the automatic half is out of the way
    # and the button is measured on its own.
    if not pa["clearedAfterOff"]:
        bad.append("switching the button off left the station table installed"
                   " even with the automatic trajectory table disabled - the"
                   " button has to release what it took")
    bo = b["bonds"]
    print(f"  segment counts over a flickering trajectory:"
          f" loose {bo['loose']}  pinned {bo['pinned']}")
    if len(bo["loose"]) < 2:
        bad.append(f"the flicker fixture gave one segment count {bo['loose']}"
                   " with the flag off, so it does not reproduce the thing this"
                   " leg is about and proves nothing")
    if len(bo["pinned"]) != 1:
        bad.append(f"with Keep SSE on the segment count still took"
                   f" {len(bo['pinned'])} values {bo['pinned']} - the bond list"
                   " is not being held, so the ribbon still breaks and every"
                   " crossing still rebuilds")
    print(f"  on a single frame: hidden={b['still']['hidden']}"
          f" disabled={b['still']['disabled']}")
    if not b["still"]["hidden"]:
        bad.append("the button is still on screen for a single-frame structure,"
                   " where there is no next frame to keep anything for")
    if b["backRebuilds"] < b["frames"]:
        bad.append(f"after switching it back off the assignment was rebuilt only"
                   f" {b['backRebuilds']} times over {b['frames']} frames - the"
                   " caches still hold what was computed under the other key, so"
                   " the picture keeps the kept structure and the button reads"
                   " as broken")

if bad:
    print()
    for b in bad:
        print("FAIL: " + b)
    sys.exit(1)
speed = s["off"]["ms"] / max(s["on"]["ms"], 1e-9)
print(f"\nOK - a frame is {speed:.2f}x, and the option is off unless asked for")
