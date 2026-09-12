"""ONE ACTION, ONE RENDER.

    python3 tests/render_counts.py [1UBQ.cif]

A control that draws the frame twice is invisible from the outside - the
picture is right, it just cost double - and it happens in one particular way
here often enough to be worth a gate: reloadDrawn() ends in
_composeAndApplyMask, which RENDERS unless told not to, so the natural-looking
"reload, then render" draws twice. Five places had it, including the side-chain
toggle, which is the most clicked control on the page.

Every render is counted, with what asked for it, so a failure names the second
caller instead of leaving someone to find it.

🔴 renderSoon IS NOT A RENDER. It coalesces to one render on the next animation
frame, which is the whole point of it, so it is recorded and not counted - a
slider that asks three times during a drag and draws once is right, and a file
that counted the asking would call that a failure.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_rendercounts.html")
PORT = 9815
DEBUG_PORT = 9816
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);

    const realRender = r.render.bind(r);
    let calls = [];
    r.render = (why) => { calls.push(String(why)); return realRender(why); };
    const realSoon = r.renderSoon ? r.renderSoon.bind(r) : null;
    if (realSoon) {
      r.renderSoon = (why) => { calls.push('soon:' + String(why)); return realSoon(why); };
    }

    const out = [];
    const measure = async (name, fn) => {
      calls = [];
      window.__faceBuilds = 0;
      const ran = await fn();
      if (ran === false) { out.push({name, missing: true}); return; }
      // 🔴 WAIT FOR THE STYLE SWITCH TO FINISH. setStyle can defer its draw -
      // _quietStyle and _switchQuiet are the two latches it holds while it
      // does - so a fixed settle catches "style to cartoon" mid-switch and
      // reports 0 renders, which this file would then call a dead control.
      await until(() => !r._quietStyle && !r._switchQuiet, 20000);
      await settle(8);
      out.push({name, calls: calls.slice(),
                renders: calls.filter((c) => c.indexOf('soon:') !== 0).length,
                builds: window.__faceBuilds});
    };
    const control = async (name, sel, kind) => {
      await measure(name, async () => {
        const el = document.querySelector(sel);
        if (!el || el.disabled) return false;
        if (kind === 'check') {
          el.checked = !el.checked;
          el.dispatchEvent(new Event('change', {bubbles: true}));
        } else {
          el.value = String(parseFloat(el.value) + 0.2);
          el.dispatchEvent(new Event('input', {bubbles: true}));
        }
      });
    };

    await control('cyclic', '#cyclicCheckbox', 'check');
    await control('arrows', '#arrowsCheckbox', 'check');
    await control('smooth', '#smoothCheckbox', 'check');
    await control('shade', '#shadeSlider', 'range');
    await control('thickness', '#thicknessSlider', 'range');
    await control('sheet flat', '#sheetFlatSlider', 'range');
    await control('line width', '#lineWidthSlider', 'range');
    await control('outline width', '#outlineWidthSlider', 'range');
    await control('pencil', '#pencilSlider', 'range');
    // ...the controls that switch a whole mode, which are the ones most
    // likely to reload and then render
    const sel = async (name, selector, value) => {
      await measure(name, async () => {
        const el = document.querySelector(selector);
        if (!el || el.disabled) return false;
        el.value = value;
        el.dispatchEvent(new Event('change', {bubbles: true}));
      });
    };
    // 🔴 THE OPTION VALUES ARE PRESET NAMES, NOT 'cartoon'. The select offers
    // tube beside the cartoon PRESETS - richardson, ribbon - because "Cartoon"
    // was never a look on its own (see uiStyleOf in parts/ui.js). Setting
    // 'cartoon' leaves a select with no such option at "", setStyle rejects it,
    // and the row reads 0 renders as though the control were dead. Read what
    // is actually there instead.
    const styleEl = document.querySelector('#styleSelect');
    const opts = styleEl ? Array.from(styleEl.options).map((o) => o.value) : [];
    const backTo = opts.filter((v) => v && v !== 'tube')[0] || null;
    await sel('style to tube', '#styleSelect', 'tube');
    if (backTo) await sel('style to ' + backTo, '#styleSelect', backTo);
    await measure('clip', async () => {
      const c = document.querySelector('#clipCheckbox');
      if (!c || c.disabled) return false;
      c.checked = !c.checked;
      c.dispatchEvent(new Event('change', {bubbles: true}));
    });

    // 🔴 THE ACTIONS THAT ARE NOT PANEL CONTROLS, which is where the six
    // instances of "reload, then render" were found - including setFrame, on
    // every step of every animation.
    // ...only where there IS another frame. On a single-frame structure -
    // which is what this file loads by default - setFrame(1) is a no-op and
    // correctly draws nothing; asserting a render there tests the fixture.
    const ownFrames = ((r.objectsData[r.currentObjectName] || {}).frames || []).length;
    if (ownFrames > 1) {
      await measure('next frame', async () => { r.setFrame(1); });
      await measure('frame back', async () => { r.setFrame(0); });
    }
    // ...and the top-level buttons, which are user actions like any other
    const press = async (name, selector) => {
      await measure(name, async () => {
        const el = document.querySelector(selector);
        if (!el || el.disabled) return false;
        el.click();
      });
    };
    await press('focus on*', '#focusButton');
    await press('focus off*', '#focusButton');
    await press('clip auto*', '#clipAutoButton');
    await press('clip auto off*', '#clipAutoButton');
    if (r.orient) {
      await measure('orient*', async () => { r.orient(); });
    }

    // NOT setShownObjects with the set it already has, and not
    // setBackboneHiddenFor: the first is a no-op and correctly draws nothing,
    // and the second RETURNS whether anything changed and leaves the render to
    // its caller - that is its contract, and a probe that called it directly
    // and demanded a frame was testing its own assumption. Both were here and
    // both are gone.
    if (r.setResidueSelection) {
      await measure('set selection', async () => {
        r.setResidueSelection(new Set([4, 5, 6]));
      });
      await measure('clear selection', async () => {
        r.setResidueSelection(new Set());
      });
    }
    // ...and the public side-chain API, which is the same trap and is not a
    // control on the panel
    if (r.showSidechains) {
      await measure('show side chains', async () => { r.showSidechains([10, 11, 12]); });
      await measure('hide side chains', async () => { r.hideSidechains([10, 11, 12]); });
    }
    r.render = realRender; if (realSoon) r.renderSoon = realSoon;
    return {out};
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
profile_dir = "/tmp/py2dmol-rendercounts"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_rendercounts.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
print(f"{FILE}: renders per action")
for row in out["out"]:
    if row.get("missing"):
        print(f"  {row['name']:<18} (not on this page)")
        continue
    print(f"  {row['name']:<18} {row['renders']} render(s), {row['builds']} build(s)")
    for c in row["calls"]:
        print(f"        {c}")
    # 🔴 A NAME ENDING IN * ANIMATES, and "one action, one render" is not its
    # rule. Focus and Clip Auto move the camera over several frames on purpose
    # - the renders are called focusMove - and orient turns the model. Counting
    # those as double draws would push someone to "fix" a transition into a
    # jump. They are reported, and only required to draw SOMETHING.
    if row["name"].endswith("*"):
        continue
    if row["renders"] > 1:
        bad.append(f"{row['name']} drew the frame {row['renders']} times:"
                   f" {', '.join(row['calls'])}."
                   " Two causes have accounted for every instance so far:"
                   " reloadDrawn() and _composeAndApplyMask() both RENDER"
                   " unless passed true, so 'reload then render' draws twice;"
                   " and a repaint gated on the wrong flag - endPreviewOnRenderer"
                   " asked whether a snapshot existed (true after any frame)"
                   " rather than whether a preview was on screen. The caller"
                   " named above is where to look")
    if row["renders"] < 1:
        bad.append(f"{row['name']} drew nothing at all, so it either does"
                   " nothing or the page is not wired to it")

print()
for b in bad:
    print("FAIL: " + b)
print("render counts: " + ("FAILED" if bad else "one action, one render"))
sys.exit(1 if bad else 0)
