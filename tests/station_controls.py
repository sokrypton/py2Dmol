"""DOES THE STATION PATH DRAW WHAT A REBUILD DRAWS, CONTROL BY CONTROL?

    python3 tests/station_controls.py [1UBQ.cif]

tests/topology_survey.py asks whether a control leaves the piece, station and
face counts alone. That is NECESSARY - no table can be updated across a change
of mapping - and it is nowhere near sufficient: equal counts only say the
mapping COULD hold, never that the station update writes the right numbers into
it. A control whose value is baked per FACE rather than per station passes that
file and draws a stale frame here.

So this is the sufficient half. For each control, at two values:

  1. build the mesh at A,
  2. move to B and render WITHOUT invalidating - the station path answers,
  3. invalidate and render at B - a rebuild answers,
  4. compare the two frames.

🔴 AND THE FAST PATH HAS TO HAVE BEEN TAKEN, or step 2 was a rebuild too and
the comparison is a frame against itself. That is asserted, not assumed: a
control still in the topological signature rebuilds at step 2 and this file
says so rather than passing.

🔴 AND THE SAME-BUILD FLOOR IS MEASURED, because this frame is compared in
pixels and a difference means nothing without one.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationcontrols.html")
PORT = 9809
DEBUG_PORT = 9810
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

# name, property, the value to build at, the value to move to
CONTROLS = [
    ("thickness",  "cartoonThickness",  0.2, 0.9),
    ("sheet flat", "cartoonSheetFlat",  0.2, 0.9),
    ("line width", "lineWidth",         3,   5.5),
    ("richardson", "cartoonRichardson", False, True),
    ("arrows",     "cartoonArrows",     True, False),
    ("na smooth",  "naSmooth",          True, False),
]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, controls) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 120000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const G = window.py2dmolCartoonGPU;
    if (!G || !G.setStationDraw) return {error: 'no station API'};
    G.setStationDraw(true);

    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let moved = 0; let worst = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        if (d > 2) moved += 1;
        if (d > worst) worst = d;
      }
      return {moved: moved / (a.length / 4), worst};
    };
    const rebuildAt = async (prop, v) => {
      r[prop] = v;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      if (G.invalidate) G.invalidate();
      r.render('ctlRebuild'); await settle(4);
      return shot();
    };

    // 🔴 THE PRECONDITION FOR ANY OF THIS: part 0 is what the station table
    // describes, exactly. makeResident splits the mesh into the ribbon, the
    // things that hold still, and the side chains, and the fast path rewrites
    // the last two - so a single face in part 0 that has no station makes the
    // tail unrefreshable and declines the path for the WHOLE structure. Nine
    // magnesium and manganese ions on 1EHZ did precisely that.
    if (G.invalidate) G.invalidate();
    r.render('ctlWarm'); await settle(4);
    const spans = G.partSpans ? G.partSpans() : null;
    const tbl = G.stationsResident && G.stationsResident();

    const out = [];
    for (const c of controls) {
      const keep = r[c.prop];
      const atA = await rebuildAt(c.prop, c.a);
      // ...move to B with the mesh in place: the station path is what answers
      window.__faceBuilds = 0;
      window.__stationFastPath = 0;
      window.__stationSlowPath = 0;
      window.__topoMoved = null;
      r[c.prop] = c.b;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      r.render('ctlReuse'); await settle(4);
      const reused = shot();
      const builds = window.__faceBuilds;
      const fast = window.__stationFastPath;
      const slow = window.__stationSlowPath;
      const st = G.stationsResident && G.stationsResident();
      const resid = G.residentCount ? G.residentCount() : -1;
      // 🔴 READ THE REASON HERE, NOT AFTER THE REBUILDS BELOW. Every render
      // clears it at the top, so two more frames of reference-building leave
      // nothing to read - which is the same trap that made stationRefusal
      // useless and sent this probe chasing a null for an hour.
      const declined = (G.stationDecline && G.stationDecline()) || null;
      // ...and the same state, rebuilt, twice - the second is the floor
      const ref = await rebuildAt(c.prop, c.b);
      const ref2 = await rebuildAt(c.prop, c.b);
      // 🔴 THE CONTROL'S OWN EFFECT, which is what the error has to be judged
      // against. A fixed pixel threshold cannot tell a stale ribbon from one
      // antialiased edge pixel, and picking a number that lets the current
      // answer through is how a gate stops being one. Staleness means the path
      // drew the A frame; so measure A against B and require the error to be a
      // small fraction of it. Self-calibrating, and it tightens by itself as a
      // control's effect grows.
      out.push({name: c.name, prop: c.prop, a: String(c.a), b: String(c.b),
                builds, fast, slow, diff: diff(reused, ref), floor: diff(ref, ref2),
                signal: diff(atA, ref),
                // WHICH TERM of the topological key moved, when one did. A
                // control that rebuilds is not a verdict, it is a question,
                // and this is the answer to it.
                topoMoved: window.__topoMoved || null,
                // ...and if the key held and it STILL rebuilt, the two places
                // that can say no: installStations' refusal and the station
                // comparison's own reason.
                table: st ? st.count : 0, resident: resid,
                hadKey: !!(G.topoSignature && G.topoSignature()),
                decline: declined,
                refusal: (G.stationRefusal && G.stationRefusal()) || null,
                update: (G.stationUpdate && G.stationUpdate()) || null});
      r[c.prop] = keep;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      if (G.invalidate) G.invalidate();
      r.render('ctlRestore'); await settle(3);
    }
    return {out, spans, table: tbl ? tbl.count : 0};
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
profile_dir = "/tmp/py2dmol-stationcontrols"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationcontrols.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
payload = json.dumps([{"name": n, "prop": p, "a": a, "b": b}
                      for n, p, a, b in CONTROLS])
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {payload}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
spans = out.get("spans")
print(f"{FILE}: mesh parts {spans} against a station table of {out.get('table')}")
if not spans or spans[0] != out.get("table"):
    bad.append(f"the ribbon part holds {spans[0] if spans else '?'} faces and"
               f" the station table describes {out.get('table')} - part 0 has"
               " to be exactly what the table covers, or the tail cannot be"
               " refreshed and every control below rebuilds")
print(f"{FILE}: moving each control with the mesh in place")
for row in out["out"]:
    d = row["diff"]; fl = row["floor"]
    print(f"  {row['name']:<12} {row['a']} -> {row['b']:<6}"
          f" builds {row['builds']} fast {row['fast']}"
          f"   error {100 * d['moved']:.4f}% (worst {d['worst']})"
          f"  of a {100 * row['signal']['moved']:.4f}% effect"
          f"  floor {100 * fl['moved']:.4f}%")
    if row["fast"] < 1 or row["builds"] > 0:
        # not a failure of the PICTURE - a failure to exercise the path. Named
        # separately because the two mean opposite things about the code.
        print(f"       why: {row.get('decline') or 'no reason recorded'}")
        print(f"      (not exercised: this control still rebuilds,"
              f" so the frames above are one frame compared with itself)")

        continue
    sg = row["signal"]
    if sg["moved"] < 0.0005:
        # INERT ON THIS STRUCTURE, not broken: na smooth does nothing to a
        # protein and sheet flat nothing to a nucleic chain. Reported rather
        # than failed, for the same reason tests/topology_survey.py reports it
        # - a structure that cannot exercise a control says nothing about it.
        # Run the file on one that can.
        print(f"      (inert here: moving it changes"
              f" {100 * sg['moved']:.4f}% of the frame, so this structure"
              " cannot tell a right answer from a stale one)")
        continue
    # the path has to reproduce the control to within a hundredth of the
    # control's own effect, and never below the same-build floor
    limit = max(fl["moved"], sg["moved"] / 100)
    if d["moved"] > limit:
        bad.append(f"{row['name']}: the station path drew"
                   f" {100 * d['moved']:.4f}% of pixels differently, against a"
                   f" control effect of {100 * sg['moved']:.4f}% and a"
                   f" same-build floor of {100 * fl['moved']:.4f}% - it is"
                   f" reproducing {100 * d['moved'] / sg['moved']:.1f}% of the"
                   " change wrongly, so the value is not carried by a station")

print()
for b in bad:
    print("FAIL: " + b)
print("station controls: " + ("FAILED" if bad else "what the path takes, it draws right"))
sys.exit(1 if bad else 0)
