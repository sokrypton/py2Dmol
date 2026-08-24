"""The built Style panel renders at a usable size, on the page's own skin.

    python3 tests/panel.py

WHY THIS EXISTS. The panel used to be markup in index.html and again in
viewer.html; it is one table in parts/panel.js now, built at runtime and skinned
by each page's CSS. That split has a failure mode the rest of the suite cannot
see: every id is present, every control is wired, every behavioural assertion
passes - and the thing renders 111 pixels wide with zero-width sliders because
it was mounted in the wrong container, or because the page has no rules for the
classes the builder emits.

Both of those happened. The suite was ALL GREEN through both.

So this asks the only question the others do not: is it the right size and shape
once the browser has laid it out. Not pixel-exact - the numbers below are floors
and ceilings, not a golden image - because the point is catching a panel that is
crushed, overflowing or unstyled, not policing a 2px change.
"""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_panel.html')
PORT = 9726

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  (async () => {
    const R = {};
    try {
      const txt = await (await fetch('/1UBQ.cif')).text();
      await window.processFiles([{name: '1UBQ.cif',
          readAsync: () => Promise.resolve(txt)}], false);
      await until(() => { const v = window.py2dmol_viewers
          && window.py2dmol_viewers['standalone-viewer-1']; return v && v.renderer; }, 9000);
      await settle(4);
      const toggle = document.querySelector('#styleToggle');
      if (toggle) toggle.click();
      await settle(4);

      const p = document.querySelector('#stylePanel');
      R.built = !!p;
      if (!p) throw new Error('no #stylePanel in the page');
      const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
      const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      R.panelW = w(p);
      R.panelH = h(p);
      // ...the narrowest control of each kind, which is where a crushed panel
      // shows first: a slider with no width is still a slider in the DOM.
      const widths = (sel) => [...p.querySelectorAll(sel)]
          .filter((el) => el.offsetParent !== null).map(w);
      R.sliders = widths('input[type=range]');
      R.selects = widths('select');
      R.toggles = widths('.btn-toggle');
      R.labels = widths('label:not(.btn-toggle)');
      // ...and it stays inside whatever it was mounted in
      const parent = p.parentElement.getBoundingClientRect();
      const box = p.getBoundingClientRect();
      R.overflows = Math.round(box.right - parent.right);
      // ...visible rows, so a panel that collapsed to nothing is not "fine"
      R.visibleRows = [...p.children]
          .filter((r) => getComputedStyle(r).display !== 'none').length;
      // ...AND THE TEXT FITS ITS BOX VERTICALLY. Width is not the only way a
      // control can be wrong: #colorSelect fell back to a 14px font with 8px of
      // padding inside a 28px box, so the descenders were cut off - and every
      // width assertion above passed while it did.
      //
      // A line of text needs about 1.25x its font size; add the padding and the
      // borders and compare with the height the box actually has.
      R.tight = [...p.querySelectorAll('select, label:not(.btn-toggle), .btn-toggle span')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => {
          const c = getComputedStyle(el);
          const need = parseFloat(c.fontSize) * 1.25
              + parseFloat(c.paddingTop) + parseFloat(c.paddingBottom)
              + parseFloat(c.borderTopWidth) + parseFloat(c.borderBottomWidth);
          return {id: el.id || el.textContent.trim().slice(0, 12) || el.tagName,
                  need: Math.round(need),
                  has: Math.round(el.getBoundingClientRect().height)};
        })
        .filter((x) => x.need > x.has);

      // ...the CSS is actually reaching it: an unstyled div is `block`, and
      // every skin makes these rows flex.
      R.rowDisplay = [...new Set([...p.children]
          .filter((r) => getComputedStyle(r).display !== 'none')
          .map((r) => getComputedStyle(r).display))];
    } catch (e) { R.threw = String((e && e.message) || e); }
    fetch('/result', {method: 'POST', body: JSON.stringify(R)});
  })();
});
</script>"""
JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)

open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read()
                      .replace('</body>', JS + '</body>'))
box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.request_queue_size = 128
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
proc = subprocess.Popen(
    [CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-panel",
     "--no-first-run", "--window-size=1500,1000",
     f"http://127.0.0.1:{PORT}/_panel.html"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
proc.kill()
httpd.shutdown()
shutil.rmtree("/tmp/py2dmol-panel", ignore_errors=True)
try:
    os.remove(PROBE)
except OSError:
    pass

R = box[0] if box else {"threw": "the page never posted a result"}
if R.get("threw"):
    sys.exit("FAIL: " + R["threw"])

print(f"  panel {R['panelW']}x{R['panelH']}, {R['visibleRows']} rows visible,"
      f" display {R['rowDisplay']}")
print(f"  sliders {R['sliders']}")
print(f"  selects {R['selects']}  toggles {R['toggles']}  labels {R['labels']}")
print(f"  vertically clipped: {R.get('tight') or 'none'}")

bad = []
# A PANEL NARROWER THAN ITS OWN CAPTION IS MOUNTED IN THE WRONG BOX. It came out
# at 111 px inside a toolbar row; the column it belongs in is ~300.
if R['panelW'] < 200:
    bad.append(f"the panel is {R['panelW']}px wide - it is mounted somewhere too"
               " narrow for it")
if R['visibleRows'] < 5:
    bad.append(f"only {R['visibleRows']} rows are visible")
if R['rowDisplay'] != ['flex']:
    bad.append(f"rows render as {R['rowDisplay']} - the page has no CSS for the"
               " classes the builder emits, so the panel is unstyled")
for name, got, floor in (('slider', R['sliders'], 40), ('select', R['selects'], 60),
                         ('toggle', R['toggles'], 40), ('label', R['labels'], 20)):
    if not got:
        bad.append(f"no visible {name} in the panel")
    elif min(got) < floor:
        bad.append(f"the narrowest {name} is {min(got)}px, under {floor} - the"
                   f" panel is crushed ({got})")
for t in R.get('tight', []):
    bad.append(f"{t['id']} needs {t['need']}px of height and has {t['has']}px -"
               ' the text is clipped')
if R['overflows'] > 2:
    bad.append(f"the panel overflows its container by {R['overflows']}px")

for b in bad:
    print("FAIL: " + b)
print('ok' if not bad else f'{len(bad)} problems')
sys.exit(1 if bad else 0)
