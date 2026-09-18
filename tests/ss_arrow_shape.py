"""WHAT A SHORT STRAND IS SHAPED LIKE, at every Detail.

    python3 tests/ss_arrow_shape.py

`tests/ss_axis.py` and `tests/arrow_rebuilds.py` guard what an arrowhead
COSTS - that a letter changing moves no station, so a trajectory keeps the
fast path. Nothing guarded what it LOOKS LIKE, and three faults shipped
behind that gap, each of them invisible to a count:

  * A ONE-RESIDUE SHEET. A strand is drawn over the INTERVALS between
    consecutive 'E' residues, so a lone one has no interval to be drawn in -
    but the WIDTH is keyed per residue, so the ribbon bulged to full sheet
    width around a single point with the head sitting nowhere. Reported as a
    one-residue sheet drawing an arrow with sides missing.
  * THE FLOOR'S SPEAR. At Detail 2 an interval cannot spare a station for the
    seam, so the seam used to MOVE onto one the interval already had - which
    leaves no duplicate to stand the barbs up, and the width ramped from shaft
    to barb over the sub-interval before it. A spearpoint, not an arrow.
  * AND A TWO-RESIDUE STRAND THAT WAS ALL HEAD. Where the interval is its own
    blunt start AND its own arrow, the head fills it - which is right at the
    floor, where there is no seam to split at, and wrong above it, where there
    are stations for one: a triangle as long as the whole strand instead of a
    short strand with an arrow on the end.

WHAT THIS ASKS, of a synthetic 16-residue chain with a strand of 1, 2, 3 or 5
residues forced through the `sse` override, at Detail 2, 3 and 4:

  1. A LONE 'E' DRAWS AS LOOP. Every station in the chain sits at the loop's
     own half-width and no arrowhead is built at all.
  2. THE HEAD'S BACK EDGE IS SQUARE, at every length and every Detail: two
     stations at the SAME POINT, one carrying the shaft's half-width and one
     the barbs'. A ramp has no coincident pair, which is what separates the
     arrow from the spear.
  2b. AND THE BLUNT START IS A BAND RATHER THAN A JUMP. 🔴 A coincident pair is
     NOT enough to say a step has a surface: two intervals meeting also put two
     stations on one point, and nothing emits a face BETWEEN intervals. The
     rim's own duplicate is what carries the blunt end, so the strand's first
     point must hold at least TWO stations at the loop's width - the previous
     interval's last, and the rim's own first copy - with the step after them.
     With one, the width jumps where no face is, which is a HOLE. It was
     reported as the back of a two-residue arrow missing a face, and the cause
     is that the arrowhead's width rule ran after the rim's and overwrote it:
     a two-residue strand is the only interval that is its own blunt start AND
     its own head.
  2c. AND THE HEAD MEETS THE LOOP AFTER IT WITHOUT A HOLE. Above the floor
     the head tapers to a point and the loop opens with a WALL - a coincident
     step from the point's width up to the loop's, closing what used to be an
     open tube. At the floor the head ends SQUARE at the loop's width instead, so
     nothing in the chain is narrower than the loop: no point, no wall. That
     is the natural join, and it is also what keeps the loop's curve - a wall
     there costs one of the interval's two sub-intervals, and on 6MRR's
     C-terminus that left one straight band to carry a 60 degree turn,
     reported as the loop squished at its end.
  3. THE HEAD IS THE WHOLE INTERVAL AT THE FLOOR AND A FIXED LENGTH ABOVE IT.
     At Detail 3 and 4 it is the same number of Angstrom whatever the strand's
     length - the arc-length solve's whole point - and strictly shorter than
     the interval, so there is shaft in front of it. At Detail 2 it is the
     interval, because there is nothing to split.
  4. AND THE STATION COUNT DOES NOT MOVE WITH THE LETTER, restated here so
     that none of the three above can be bought with topology.

The numbers are read off the drawing rather than written down: the barb is the
widest half-width, the shaft the widest below it, the loop the one a chain with
no strand in it draws. A look that retunes its profile moves all three together
and this file goes on asking the same questions.

THE FIXTURE IS INLINE because `*.pdb` is gitignored - a test whose input is not
tracked is a test nobody else can run.
"""
import json, os, shutil, sys, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_ssarrowshape.html")
PORT, DEBUG_PORT = 9823, 9824

# A gentle 16-residue arc of alpha carbons, 3.8 A apart. Straight enough that
# the strand's frames are stable and curved enough not to be a degenerate line.
FIXTURE = "\n".join(
    "ATOM  %5d  CA  ALA A%4d    %8.3f%8.3f%8.3f  1.00  0.00           C"
    % (i + 1, i + 1, x, y, 0.0)
    for i, (x, y) in enumerate([
        (-26.149, -9.731), (-23.160, -7.387), (-19.962, -5.337),
        (-16.584, -3.600), (-13.056, -2.191), (-9.411, -1.123),
        (-5.681, -0.405), (-1.899, -0.045), (1.899, -0.045),
        (5.681, -0.405), (9.411, -1.123), (13.056, -2.191),
        (16.584, -3.600), (19.962, -5.337), (23.160, -7.387),
        (26.149, -9.731),
    ])) + "\nEND\n"

JS = """
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  const frame = () => new Promise(r => requestAnimationFrame(
    () => requestAnimationFrame(r)));
  const txt = %FIXTURE%;
  await window.processFiles(
    [{name: 'arc.pdb', readAsync: () => Promise.resolve(txt)}], false);
  await until(loaded, 15000);
  await settle(8);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const obj = r.objectsData[r.currentObjectName];
  const n = r.coords.length;
  const AT = 7;                     // the strand starts here, mid-chain
  window.__stationFloatProbe = 1;
  const out = {n, arms: {}};
  for (const detail of [2, 3, 4]) for (const len of [0, 1, 2, 3, 5]) {
    const sse = new Array(n).fill('C');
    for (let i = 0; i < len; i++) sse[AT + i] = 'E';
    obj.sse = sse;
    r.cartoonDetail = detail;
    if (G.setStationDraw) G.setStationDraw(true);
    // 🔴 THE PRIMS ARE HARVESTED ON A BUILD AND ONLY ON A BUILD, so the probe
    // has to be armed BEFORE the rebuild is forced - a second render over a
    // resident mesh never runs geom.js and collects nothing.
    r._arrowProbe = [];
    G.clearResident && G.clearResident();
    G.clearResidentStations && G.clearResidentStations();
    r.invalidate && r.invalidate();
    r._invalidateSegmentCache && r._invalidateSegmentCache();
    r.render('probe'); await frame(); await frame();
    r.render('probe'); await frame(); await frame();
    const heads = (r._arrowProbe || []).slice();
    r._arrowProbe = null;
    const S = window.__lastStations;
    if (!S) { out.arms['len' + len + '_d' + detail] = {err: 'no stations'};
              continue; }
    const rows = [];
    for (let i = 0; i < S.length; i += 16) {
      rows.push({x: S[i], y: S[i + 1], z: S[i + 2], hw: +S[i + 3].toFixed(3)});
    }
    // 🔴 A COINCIDENT PAIR IS A STEP IN THE SURFACE, and the interesting ones
    // are the rim (loop -> shaft) and the head's back edge (shaft -> barb).
    // Consecutive intervals share an endpoint, so most coincidences are joins
    // with no width change at all; the widths are what name this one.
    const steps = [];
    for (let i = 1; i < rows.length; i++) {
      const d = Math.hypot(rows[i].x - rows[i - 1].x, rows[i].y - rows[i - 1].y,
                           rows[i].z - rows[i - 1].z);
      if (d < 0.02 && rows[i].hw !== rows[i - 1].hw) {
        steps.push([rows[i - 1].hw, rows[i].hw]);
      }
    }
    out.arms['len' + len + '_d' + detail] = {
      // x, y and the half-width, for the blunt-start check below
      rows: rows.map((v) => [+v.x.toFixed(3), +v.y.toFixed(3), v.hw]),
      stations: rows.length,
      widths: [...new Set(rows.map((v) => v.hw))].sort((a, b) => a - b),
      steps,
      heads: heads.map((h) => [h.len, h.interval]),
    };
  }
"""
JS = JS.replace('//HELPERS', HELPERS).replace('%FIXTURE%', json.dumps(FIXTURE))

open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read())


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()

proc = None
R = {}
try:
    proc, ws = cdp.launch(DEBUG_PORT, '/tmp/py2dmol-ss-arrow-shape')
    ws.call('Page.enable'); ws.call('Runtime.enable')
    ws.call('Emulation.setDeviceMetricsOverride', width=1100, height=900,
            deviceScaleFactor=1, mobile=False)
    ws.call('Page.navigate', url='http://127.0.0.1:%d/_ssarrowshape.html' % PORT)
    cdp.wait_for(ws, "typeof window.processFiles === 'function'",
                 what="dev.html to load")
    R = cdp.evaluate(ws, '(async () => {\n' + JS + '\nreturn out; })()') or {}
finally:
    if proc: proc.kill()
    httpd.shutdown()
    if os.path.exists(PROBE): os.remove(PROBE)
    shutil.rmtree('/tmp/py2dmol-ss-arrow-shape', ignore_errors=True)

arms = R.get('arms') or {}
bad = []
if len(arms) != 15:
    bad.append("measured %d arms of the 15 asked for" % len(arms))

# The three widths are read off the drawing: the loop's is what a chain with no
# strand in it draws, the barb is the widest anywhere, the shaft the widest
# below it. Written down instead they would be a second copy of the profile.
plain = arms.get('len0_d4') or {}
loopW = (plain.get('widths') or [None])[0]
if not loopW or len(plain.get('widths') or []) != 1:
    bad.append("a chain with no strand should draw one width, got %s"
               % (plain.get('widths'),))
five = arms.get('len5_d4') or {}
wide = sorted(w for w in (five.get('widths') or []) if w > (loopW or 0))
barbW = wide[-1] if wide else None
shaftW = max((w for w in wide[:-1]), default=None) if len(wide) > 1 else None
print("  widths: loop %s, shaft %s, barb %s" % (loopW, shaftW, barbW))
if not barbW or not shaftW:
    bad.append("no strand profile in the drawing at all - nothing else here"
               " can mean anything")

def same(p, q):
    return abs(p[0] - q[0]) < 0.02 and abs(p[1] - q[1]) < 0.02


for detail in (2, 3, 4):
    counts = set()
    for ln in (0, 1, 2, 3, 5):
        a = arms.get('len%d_d%d' % (ln, detail)) or {}
        if a.get('err') or 'stations' not in a:
            bad.append("len%d_d%d: %s" % (ln, detail, a.get('err', 'no data')))
            continue
        counts.add(a['stations'])
        heads = a.get('heads') or []
        steps = [tuple(s) for s in (a.get('steps') or [])]
        print("  len%d d%d: %3d stations, widths %s, steps %s, head %s"
              % (ln, detail, a['stations'], a['widths'], steps, heads))
        if ln <= 1:
            # 1. a lone bridge is not a strand
            if a['widths'] != [loopW]:
                bad.append("len%d_d%d draws %s - a %d-residue strand has no"
                           " interval to be drawn in, so it must draw as loop"
                           % (ln, detail, a['widths'], ln))
            if heads:
                bad.append("len%d_d%d built an arrowhead (%s)"
                           % (ln, detail, heads))
            continue
        # 2b. the blunt start is a band: two stations at the loop's width
        rows = a.get('rows') or []
        first = next((k for k, v in enumerate(rows) if v[2] > loopW), None)
        if first is None or first < 2:
            bad.append("len%d_d%d: nothing wider than the loop was drawn"
                       % (ln, detail))
        else:
            # ...and only where the start is a STEP. Below the subdivision
            # that can spare a duplicate the blunt end is a CHAMFER instead -
            # the width ramps over the first sub-interval, which is continuous
            # and needs no face of its own (geom.js, where `dupRim` is
            # decided). What must never happen is a step with nothing to
            # close it.
            if same(rows[first - 1], rows[first]):
                before = [rows[first - 2], rows[first - 1]]
                if not all(same(v, rows[first]) and v[2] == loopW
                           for v in before):
                    bad.append("len%d_d%d: the strand steps %s -> %s with only"
                               " one station at the loop's width, so the step"
                               " falls BETWEEN two intervals, where nothing"
                               " emits a face - a hole in the blunt end"
                               % (ln, detail, [v[2] for v in before],
                                  rows[first][2]))
        # 2c. how the head meets the loop after it
        if detail == 2:
            if min(a['widths']) < loopW:
                bad.append("len%d_d2 draws half-widths down to %s, under the"
                           " loop's %s - the head should end SQUARE at the loop"
                           " at the floor, with no point and no wall"
                           % (ln, min(a['widths']), loopW))
        elif not any(hi == loopW and lo < 0.2 * shaftW for lo, hi in steps):
            bad.append("len%d_d%d has no wall from the point up to the loop's"
                       " width - the loop after the arrow starts as an open tube"
                       % (ln, detail))
        # 2. the back edge is square: a coincident pair ENDING at the barb.
        # What is in FRONT of it is the shaft, except where the head begins at
        # the strand's own blunt start - a two-residue strand at the floor -
        # and there it is the loop the strand grew out of.
        if not any(hi == barbW for _lo, hi in steps):
            bad.append("len%d_d%d has no step up to %s at a single point - the"
                       " barbs ramp up instead of standing on a square back"
                       " edge, which is the spearpoint"
                       % (ln, detail, barbW))
        # 3. how much of the interval the head took
        if len(heads) != 1:
            bad.append("len%d_d%d built %d arrowheads, expected 1"
                       % (ln, detail, len(heads)))
            continue
        hlen, interval = heads[0]
        # A head has a shaft in front of it exactly when its interval can
        # afford a seam of its own. At the floor nothing can. A TWO-RESIDUE
        # strand is one interval that is its own blunt start and its own
        # arrow, so it has to buy the rim's duplicate and the seam's out of
        # one budget: at Detail 4 it can, at Detail 3 it cannot and the rim
        # wins, which is what makes it draw the floor's clean triangle rather
        # than a chamfer running into the barbs.
        fills = detail == 2 or (ln == 2 and detail == 3)
        if fills and abs(hlen - interval) > 1e-3:
            bad.append("len%d_d%d: the head is %.3f of a %.3f interval - with"
                       " no seam of its own it is all head"
                       % (ln, detail, hlen, interval))
        if not fills and hlen >= interval - 1e-3:
            bad.append("len%d_d%d: the head is the whole %.3f interval - this"
                       " one has the stations for a real seam, so it keeps its"
                       " shaft" % (ln, detail, interval))
    if len(counts - {None}) > 1:
        bad.append("Detail %d: the station count moved with the strand's"
                   " length (%s) - a letter must not move the topology"
                   % (detail, sorted(counts)))

# ...and above the floor the head is a LENGTH, not a fraction of whatever
# interval it landed in: the arc-length solve exists to make it constant.
for detail, lengths in ((3, (3, 5)), (4, (2, 3, 5))):
    lens = {ln: (arms.get('len%d_d%d' % (ln, detail)) or {}).get('heads')
            for ln in lengths}
    vals = [v[0][0] for v in lens.values() if v]
    if len(vals) == len(lengths) and max(vals) - min(vals) > 1e-3:
        bad.append("Detail %d head lengths differ by strand length: %s"
                   % (detail, vals))

if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('ss arrow shape: a short strand is an arrow, and a lone one is a loop')
