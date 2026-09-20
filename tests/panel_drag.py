"""DRAGGING A STYLE CONTROL COSTS ONE BUILD, NOT ONE PER STEP.

    python3 tests/panel_drag.py [1TIM.cif]

tests/topology_survey.py asks which controls MOVE the station mapping and
tests/station_controls.py asks whether the station path draws them right. This
asks the question a reader actually has: I am dragging this slider - how many
times does the mesh get rebuilt?

They are not the same question, and the gap between them is where this found
something. The station fast path is armed automatically only for a TRAJECTORY
(`frames.length > 1`); a single structure "pays nothing until something asks",
and what asks is `wantStationTable()` in parts/ui.js. Thickness and Flat ask.
WIDTH DID NOT - it is wired in core/mol.js rather than in ui.js and was simply
never told - so every step of a Width drag rebuilt the whole mesh, 7 of 7, the
only control in the panel that did. It is in the full mesh signature and out of
the topological one exactly so the station path can answer it.

WHAT IS ASSERTED is a budget per control and WHERE the rebuilds fall. Both
matter: a control that rebuilds once is fine wherever that build lands, and a
control that rebuilds at step 0 and then never again is a drag that costs one
build - which is the claim. Measured on 1TIM, seven steps across each slider's
full range:

    detail           6/7  every step        subdivision count: no table survives it
    line width       1/7  at step 0         the build that makes the table
    thickness        2/7  at steps 0 and 1  ...and the flat/solid crossing at 0
    sheet flat       1/7  at step 0
    outline width    1/7  at step 0         0 -> nonzero turns the ink on
    arrows           1/2                    in the topological key on purpose
    use gpu          1/2                    a different painter
    everything else  0

🔴 DETAIL IS ASSERTED TO REBUILD, not merely allowed to. It is the one control
here that genuinely cannot be a table update - 150/300/602 pieces, stations and
faces at detail 2 against 305/905/2402 at 8 - so a build that stopped happening
would mean the slider had stopped working, and every other number in this file
would still look perfect.

MUTATED THREE WAYS. Taking the `setStationDraw` call out of the Width
listener puts it back to 7 of 7 and fails; removing `cartoonDetail` from the
mesh signature altogether makes the slider draw nothing and fails on the
must-rebuild rule. The third is recorded because it PASSES and should not be
retried: moving `cartoonDetail` out of the TOPOLOGICAL key alone changes
nothing here, because detail never asks for a station table either, so the
path is off and it rebuilds by that route instead. Two mechanisms have to fail
together before that slider goes quiet.

IT DRIVES THE REAL CONTROLS, not renderer fields: what was wrong was a missing
line in an event listener, and nothing that sets `renderer.lineWidth` by hand
can see that. A rebuild is counted by clearing `window.__rebuild` before the
event and asking whether the render that follows filled it in.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_paneldrag.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1TIM.cif"
STEPS = 7

# id -> how many of the STEPS steps may rebuild. Anything not named may not
# rebuild at all. A control that is ALLOWED to rebuild on every step says so
# with STEPS, and `detail` is required to.
BUDGET = {
    "detailSlider": STEPS,          # subdivision count - see the header
    "lineWidthSlider": 1,           # the build that makes the station table
    "thicknessSlider": 2,           # ...and the flat/solid crossing at 0
    "sheetFlatSlider": 1,
    "outlineWidthSlider": 1,        # 0 -> nonzero turns the ink on
    "arrowsCheckbox": 2,            # in the topological key on purpose
    "useGpuCheckbox": 2,            # a different painter entirely
}
MUST_REBUILD = {"detailSlider"}
# A drag is one build at the START, not one scattered through it. Named
# controls are held to that; the rest are held to their budget alone.
FIRST_ONLY = {"lineWidthSlider", "sheetFlatSlider", "outlineWidthSlider",
              "thicknessSlider"}

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {rows: []};
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f')); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.styleChosen = true;
      r.useGPU = true;
      r.setStyle('richardson');
      r.drawMode = false;
      await settle(); await settle();
      R.frames = ((r.objectsData || {})[r.currentObjectName] || {}).frames;
      R.frames = R.frames ? R.frames.length : 0;

      const controls = [];
      document.querySelectorAll('input[type=range], input[type=checkbox]')
        .forEach((el) => {
          if (!el.id) return;
          if (el.closest('#paeContainer, #heatmapContainer')) return;
          controls.push(el);
        });

      const STEPS = parseInt(P.get('steps'), 10);
      const step = async (el, v) => {
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
        window.__rebuild = null;
        el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change',
                                   {bubbles: true}));
        // some handlers only schedule; make the frame happen now
        r.render('drag');
        await settle(2);
        const G = window.py2dmolCartoonGPU;
        return {reb: !!(window.__rebuild && window.__rebuild.total !== undefined),
                why: (G && G.stationDecline) ? G.stationDecline() : null};
      };

      for (const el of controls) {
        const at = []; let why = null; let n = 0;
        if (el.type === 'range') {
          const lo = parseFloat(el.min); const hi = parseFloat(el.max);
          if (!isFinite(lo) || !isFinite(hi) || hi <= lo) continue;
          const start = el.value;
          for (let k = 0; k < STEPS; k++) {
            const z = await step(el, lo + (hi - lo) * (k / (STEPS - 1)));
            n++; if (z.reb) { at.push(k); why = why || z.why; }
          }
          await step(el, start);
        } else {
          const start = el.checked;
          for (const v of [!start, start]) {
            const z = await step(el, v);
            n++; if (z.reb) { at.push(n - 1); why = why || z.why; }
          }
        }
        R.rows.push({id: el.id, steps: n, at, why});
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9813), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-paneldrag",
                      "--no-first-run", "--window-size=900,900",
                      f"http://127.0.0.1:9813/_paneldrag.html?f={FILE}&steps={STEPS}"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-paneldrag", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
if R.get("frames", 0) != 1:
    bad.append(f"the fixture has {R.get('frames')} frames - the station path"
               " is armed automatically for a trajectory, so a single"
               " structure is the only thing that measures the panel")
rows = R.get("rows") or []
if len(rows) < 15:
    bad.append(f"only {len(rows)} controls were found - the Style panel did"
               " not mount, so nothing was measured")
seen = set()
for row in rows:
    seen.add(row["id"])
    n = len(row["at"])
    budget = BUDGET.get(row["id"], 0)
    if n:
        print(f"  {row['id']:<24} {n}/{row['steps']} rebuilt"
              f"  at {row['at']}  (budget {budget})"
              + (f"  {row['why']}" if row["why"] else ""))
    if n > budget:
        bad.append(f"{row['id']}: {n} of {row['steps']} steps rebuilt the mesh"
                   f" against a budget of {budget}"
                   + (f" - {row['why']}" if row["why"] else "")
                   + ". A control that only moves each station's own scalars"
                   " belongs out of the topological key AND has to ask for the"
                   " station table (wantStationTable), which a single"
                   " structure does not get by itself.")
    elif row["id"] in FIRST_ONLY and row["at"] and row["at"][0] != 0:
        bad.append(f"{row['id']}: rebuilt at step(s) {row['at']} rather than at"
                   " the start of the drag - one build to make the table is the"
                   " price, one part way through is a control leaving the fast"
                   " path behind")
for want in MUST_REBUILD:
    row = next((x for x in rows if x["id"] == want), None)
    if row is None:
        bad.append(f"{want} was not found in the panel")
    elif not row["at"]:
        bad.append(f"{want} rebuilt nothing across its whole range - it is the"
                   " subdivision count and no station table survives it, so a"
                   " build that stopped happening means the slider stopped"
                   " working")
quiet = [r["id"] for r in rows if not r["at"]]
print(f"  {len(quiet)} of {len(rows)} controls rebuild nothing at all")

if bad:
    for m in bad:
        print("FAIL: " + m)
    sys.exit(1)
print("  a drag costs one build, and detail still costs one per step")
