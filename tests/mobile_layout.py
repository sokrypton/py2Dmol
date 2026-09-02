"""index.html at a phone width: nothing may overflow sideways.

    python3 tests/mobile_layout.py

🔴 AN INLINE WIDTH IS ONE NO STYLESHEET CAN OVERRIDE, and this page had five
of them. Four were in the markup (the header, the upload box, the sequence
strip and the footer, all `style="width: 948px"`) and the fifth was worse
because it was in JAVASCRIPT: `setupViewport` wrote `canvasContainer.style
.width`, and `src/app/main.js`'s `setupCanvasDimensions` wrote the same three
lines again. No media query, no container query and no amount of specificity
beats an inline style - only `!important` does - so every responsive rule
aimed at the canvas box lost to an attribute set at load, and the failure
looks exactly like a media query that is not matching.

Guarding ONE of the two JavaScript writers bought nothing, measured: the
columns stacked correctly and the page still overflowed by 234px with the
container reading `width: 600px` inline and its own opt-out flag set. That is
why this measures the PAGE and not the stylesheet - a rule that is present and
losing is indistinguishable from a rule that is absent, from anywhere except
the rendered box.

🔴 500px IS AS NARROW AS THIS HARNESS GOES, so the width below is 500 and not
a phone. Measured, and each way out was tried: --window-size=390 and =320 both
report an innerWidth of 500; --headless=old clamps identically; and
--force-device-scale-factor does not help, because --window-size is already in
CSS pixels (780 at dsf 2 gives a 780 CSS viewport, not 390).

500 is below the 980 breakpoint, so every rule in the narrow block IS
exercised and the overflow check is real. What is NOT measured is 390, where
the shell has 110 fewer pixels for the same controls - anything that breaks
only in that band needs a real device or CDP device emulation. Said out loud
because a reader who assumed "mobile" meant 390 would be trusting a number
nobody took.

AND A HIDDEN TAB CANNOT MEASURE THIS AT ALL. The obvious workaround - an
iframe at 390px in a real browser - reported the canvas stuck at 100x600 and
looked exactly like a bug in the ResizeObserver path. `document.hidden` was
true: rAF and ResizeObserver do not run in a background tab, so the observer
that resizes the canvas had never fired once. The layout numbers from such a
frame are still good (layout does not need rAF); every size the canvas gets
from an observer is worthless.

THE DESKTOP WIDTH IS THE CONTROL, and it is not a formality: every fix here
is a rule that could just as easily have made 1200px fluid, and "no overflow"
passes trivially on a page that has thrown its layout away. It asserts the
948px shell, the side-by-side columns and the 600px canvas are all still
exactly what they were.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_mobile.html")
PORT = 9663

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const path = (e) => {
    const bits = [];
    for (let n = e; n && n.tagName && n.tagName !== 'HTML'; n = n.parentElement) {
      bits.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
        + (n.className && typeof n.className === 'string'
            ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
      if (bits.length > 3) break;
    }
    return bits.join(' < ');
  };
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      await load('4HHB.cif');
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      await settle(); await settle();

      R.viewport = window.innerWidth;
      R.scrollW = document.documentElement.scrollWidth;
      R.overflow = R.scrollW - window.innerWidth;
      R.mainDir = getComputedStyle(document.getElementById('mainContainer')).flexDirection;

      const cc = document.getElementById('canvasContainer');
      const cv = document.getElementById('canvas');
      const cr = cc.getBoundingClientRect();
      R.container = [Math.round(cr.width), Math.round(cr.height)];
      R.content = [Math.round(cc.clientWidth), Math.round(cc.clientHeight)];
      R.chain = ['viewer-container', 'mainContainer', 'viewerColumn', 'canvasContainer']
        .map((id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return [id, Math.round(b.width), cs.width, cs.minWidth, cs.display, cs.alignItems]; });
      R.canvasCSS = [Math.round(parseFloat(cv.style.width) || 0),
                     Math.round(parseFloat(cv.style.height) || 0)];
      R.shell = Math.round(
        document.getElementById('viewer-container').getBoundingClientRect().width);
      // WHAT THE RENDERER THINKS IT IS DRAWING INTO. A canvas sized correctly
      // in CSS while the renderer still believes 600 draws the structure at
      // the wrong scale into the right box - so the box alone is not the test.
      R.rendererSize = [r.displayWidth, r.displayHeight];

      // ...and NAME the offenders, so a failure is actionable rather than a number
      const seen = new Set(); R.offenders = [];
      document.querySelectorAll('*').forEach((e) => {
        const b = e.getBoundingClientRect();
        if (b.right > window.innerWidth + 1 && b.width > 40) {
          const p = path(e);
          if (!seen.has(p)) { seen.add(p); R.offenders.push(
            {el: p, w: Math.round(b.width), right: Math.round(b.right),
             inline: (e.getAttribute('style') || '').slice(0, 90)}); }
        }
      });
      R.offenders.sort((a, b) => b.right - a.right);
      R.offenders = R.offenders.slice(0, 6);
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
src = re.sub(r'(<link rel="stylesheet" href="(?!https?:)[^"]+?)(\?v=\d+)?(")',
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H); httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()

def measure(w, h, dsf=1):
    """One Chrome at one CSS viewport. --window-size is a launch flag, so a
    second width is a second browser and not a resize.

    🔴 AND THE WINDOW IS CLAMPED TO 500px WIDE, so --window-size=390 reports an
    innerWidth of 500 - measured, and 320 gives 500 too. The way past it is
    --force-device-scale-factor: the CSS viewport is the window divided by the
    scale, so 780 physical at dsf 2 IS 390 CSS px. That is a real phone width
    and also a real phone DPR, which is the more honest test anyway."""
    del box[:]
    prof = "/tmp/py2dmol-mob-%d" % w
    p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=" + prof,
        "--no-first-run", "--hide-scrollbars",
        "--force-device-scale-factor=%d" % dsf,
        "--window-size=%d,%d" % (w * dsf, h * dsf),
        "http://127.0.0.1:%d/_mobile.html" % PORT],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end: time.sleep(0.5)
    p.kill(); shutil.rmtree(prof, ignore_errors=True)
    return box[0] if box else {"error": "no result posted at %dpx" % w}

PHONE = measure(500, 900)   # ...the floor; see the note above
DESK = measure(1200, 1000)
httpd.shutdown(); os.remove(PROBE)

bad = []
for name, R in (("narrow", PHONE), ("desktop", DESK)):
    if R.get("error"): sys.exit("page error (%s): %s" % (name, R["error"]))
    print("%s: viewport %s, scrollWidth %s (overflow %s), columns %s"
          % (name, R["viewport"], R["scrollW"], R["overflow"], R["mainDir"]))
    print("   shell %s, canvas box %s (content %s), canvas css %s, renderer %s"
          % (R["shell"], R["container"], R["content"], R["canvasCSS"], R["rendererSize"]))
    for row in R["chain"]:
        print("     %-18s rect %4d  css %-8s min %-8s %s/%s" % tuple(row))
    for o in R["offenders"]:
        print("   overflows by %+d: %s  inline=%r"
              % (o["right"] - R["viewport"], o["el"], o["inline"]))

# --- the phone --------------------------------------------------------------
if PHONE["overflow"] > 1:
    bad.append("at %dpx the page scrolls sideways by %dpx - see the offenders above"
               % (PHONE["viewport"], PHONE["overflow"]))
if PHONE["mainDir"] != "column":
    bad.append("at %dpx the two columns are still %s: 600 + 8 + 340 does not fit"
               % (PHONE["viewport"], PHONE["mainDir"]))
if PHONE["container"][0] > PHONE["viewport"]:
    bad.append("the canvas box is %dpx in a %dpx viewport"
               % (PHONE["container"][0], PHONE["viewport"]))
# THE CANVAS MUST FILL THE BOX IT IS GIVEN. A fluid container with a 600px
# canvas inside it is the inline-style bug wearing a fluid layout.
if abs(PHONE["canvasCSS"][0] - PHONE["content"][0]) > 2 \
        or abs(PHONE["canvasCSS"][1] - PHONE["content"][1]) > 2:
    bad.append("the canvas is %s inside a %s content box - it did not follow its"
               " container" % (PHONE["canvasCSS"], PHONE["content"]))
# ...and the RENDERER has to agree, or it draws at the wrong scale into the right box
if abs(PHONE["rendererSize"][0] - PHONE["canvasCSS"][0]) > 2:
    bad.append("the renderer thinks it is drawing into %s while the canvas is %s"
               % (PHONE["rendererSize"], PHONE["canvasCSS"]))
if PHONE["container"][0] < PHONE["viewport"] * 0.75:
    bad.append("the canvas is only %dpx of a %dpx viewport - it stacked but did not"
               " use the width, which is most of the point"
               % (PHONE["container"][0], PHONE["viewport"]))

# --- the desktop control ----------------------------------------------------
if DESK["overflow"] > 1:
    bad.append("the DESKTOP layout overflows by %dpx" % DESK["overflow"])
if DESK["mainDir"] != "row":
    bad.append("the desktop layout stacked its columns (%s) - the breakpoint is"
               " firing too wide" % DESK["mainDir"])
if DESK["shell"] != 948:
    bad.append("the desktop shell is %dpx, not the 948 it has always been"
               % DESK["shell"])
if DESK["content"] != [598, 598]:
    bad.append("the desktop canvas content box is %s, not 598x598 (600 less its"
               " 1px border)" % DESK["content"])

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
