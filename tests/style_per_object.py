"""The style belongs to the object, and its settings belong to the style.

    python3 tests/style_per_object.py                # 6MRR + 1UBQ
    python3 tests/style_per_object.py 1TIM.cif 1UBQ.cif

Each object carries its own style, so a merge can hold a ribosome drawn as a
tube beside a peptide drawn as a ribbon. Three things had to hold for that to
be usable, and each of them was a bug first:

  * THE FRAME IS DRAWN IN THE DRAWN OBJECT'S STYLE, with that style's
    SETTINGS. `renderer.style` belongs to the object being EDITED, which is
    not always the one on screen. Reported: load 6MRR, load 1UBQ, set 6MRR to
    tube, go to Multi, switch 6MRR's eye off - and 1UBQ came back as a plain
    ribbon, with the preset dropdown still saying Richardson. The preset had
    not changed; the numbers had. It was being drawn with tube's thickness (0),
    tube's pencil (0) and tube's outline (3.0).

  * EACH STYLE REMEMBERS ITS OWN SETTINGS. They are single fields on the
    renderer and every style switch re-asserted all of them from the defaults,
    so tube's landed on cartoon's and cartoon's defaults landed back on
    whatever you had adjusted.

  * AND A MIXED PICTURE PAINTS EACH HALF WITH ITS OWN. Both passes read the
    same fields, so with a tube object selected the cartoon half was drawn
    with tube's numbers.

What the probe reads is `window.__drawProfile`, which records what a frame was
actually drawn with: the fields are restored before anything outside the render
can see them, so a Richardson and a ribbon are otherwise distinguishable only
by eye.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_styleobj.html")
# the SMALL one first and the one that will be made tube: the report's order
FILES = sys.argv[1:] or ["6MRR.cif", "1UBQ.cif"]

JS = """
<script>
window.addEventListener('load', () => {
  const P = new URLSearchParams(location.search);
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const el = (id) => document.getElementById(id);
  // FRAMES AND ANSWERS, NOT MILLISECONDS. Each step here is a call and a
  // render, and what has to happen before the next line reads the result is
  // that the browser has painted: three animation frames say that in 50 ms
  // where a flat 1,500 said it in 1,500. Where the work is ASYNCHRONOUS - a
  // file parsed, a session restored - the probe waits for the answer instead,
  // which is both faster and steadier than guessing a duration.
  const settle = async (n = 3) => {
    for (let k = 0; k < n; k++) {
      await new Promise((s) => requestAnimationFrame(() => s()));
    }
  };
  const until = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (cond()) return true;
      await settle();
    }
    return false;
  };
  const loaded = () => {
    const v = window.py2dmol_viewers && window.py2dmol_viewers['standalone-viewer-1'];
    return !!(v && v.renderer && v.renderer.coords && v.renderer.coords.length);
  };
  const go = async () => {
    const R = {};
    try {
      for (const f of P.get('files').split(',')) { await load(f); await until(loaded); await settle(); }
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = true;
      const names = Object.keys(r.objectsData);
      R.names = names;
      const sel = el('objectSelect');
      const pick = async (n) => { sel.value = n; sel.dispatchEvent(new Event('change')); await settle(); };
      const setStyle = async (v) => {
        el('styleSelect').value = v;
        el('styleSelect').dispatchEvent(new Event('change'));
        await settle();
      };
      const eyeOf = (n) => Array.from(document.querySelectorAll('#objectList .object-list-row'))
        .find((x) => x.querySelector('.object-list-name').textContent === n);

      // THE PICKER IS LIVE WITH ONE OBJECT and in Multi - it names the object
      // every panel below it acts on
      R.pickerAlive = { rowShown: !!(el('objectRow') && el('objectRow').offsetParent),
                        disabled: el('objectSelect').disabled };

      await pick(names[0]);
      await setStyle('tube');
      R.styles = names.map((n) => r.styleForObject(n));
      el('objectListButton').click(); await settle();
      R.pickerInMulti = el('objectSelect').disabled;
      for (const row of Array.from(document.querySelectorAll('#objectList .object-list-row'))) {
        if (row.classList.contains('is-hidden')) row.querySelector('.object-list-eye').click();
        await settle();
      }
      await settle();
      R.mixed = window.__mixedFrame;
      R.drawnBoth = r.drawnObjects();

      // ...THE REPORT: switch the tube object's eye off while it is still the
      // object being edited, and the cartoon left behind must be a cartoon
      eyeOf(names[0]).querySelector('.object-list-eye').click();
      await settle();
      R.afterEyeOff = { editing: r.currentObjectName, drawn: r.drawnObjects(),
                        drawnWith: window.__drawProfile, preset: r.stylePreset };

      // ...AND EACH STYLE KEEPS ITS OWN SETTINGS across a round trip
      eyeOf(names[0]).querySelector('.object-list-eye').click(); await settle();
      await pick(names[1]);
      r.cartoonThickness = 1.7; r.cartoonDetail = 6; r.render('tweak'); await settle();
      await pick(names[0]);
      R.onTube = { thickness: r.cartoonThickness, detail: r.cartoonDetail,
                   outline: r.relativeOutlineWidth, style: r.style };
      await pick(names[1]);
      R.backOnCartoon = { thickness: r.cartoonThickness, detail: r.cartoonDetail,
                          outline: r.relativeOutlineWidth, style: r.style,
                          preset: r.stylePreset };
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9787), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-styleobj",
                      "--no-first-run", "--window-size=1000,900",
                      "http://127.0.0.1:9787/_styleobj.html?files=" + ",".join(FILES)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 400
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-styleobj", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{'+'.join(FILES)}: styles {R.get('styles')}, drawn together {R.get('drawnBoth')}")
print(f"  mixed frame: {R.get('mixed')}")
ae = R.get("afterEyeOff") or {}
print(f"  tube's eye off, still editing {ae.get('editing')}: drawn {ae.get('drawn')},"
      f" preset {ae.get('preset')}, drawn with {ae.get('drawnWith')}")
print(f"  cartoon tweaked to 1.7/6 -> on the tube object {R.get('onTube')}")
print(f"  ...and back: {R.get('backOnCartoon')}")

bad = []
if R.get("pickerAlive", {}).get("disabled") or R.get("pickerInMulti"):
    bad.append("the picker is greyed - it names what the panels act on, in"
               " both modes")
if not R.get("pickerAlive", {}).get("rowShown"):
    bad.append("the object row is not on screen")
if R.get("styles") != ["tube", "cartoon"]:
    bad.append(f"the two objects did not end up one of each: {R.get('styles')}")
m = R.get("mixed") or {}
if not m.get("cartoon") or not m.get("tube"):
    bad.append(f"a picture holding both styles did not draw both halves: {m}")
dw = ae.get("drawnWith") or {}
if dw.get("style") != "cartoon":
    bad.append(f"the frame was not drawn as a cartoon: {dw}")
elif not dw.get("richardson") or not dw.get("thickness") or not dw.get("pencil"):
    bad.append("the cartoon left on screen was drawn with the OTHER style's"
               f" settings - a plain ribbon where the preset says {ae.get('preset')}:"
               f" {dw}")
back = R.get("backOnCartoon") or {}
if back.get("thickness") != 1.7 or back.get("detail") != 6:
    bad.append("the cartoon settings did not survive a visit to the tube"
               f" object: {back}")
on = R.get("onTube") or {}
if on.get("thickness") == 1.7:
    bad.append(f"the cartoon's thickness followed the selection into tube: {on}")
for b in bad:
    print("FAIL: " + b)
sys.exit(1 if bad else 0)
