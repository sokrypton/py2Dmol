"""A LONG LIVE STREAM COSTS THE SAME PER add() AT FRAME 3,000 AS AT FRAME 500.

    python3 tests/live_stream.py

Reported from the ProteinEBM notebook: one viewer, one add() per Langevin step,
and after thousands of frames the output died with Chrome's sad face. There was
no leak in the renderer - the heap grows by the frames it keeps, and the WebGL
objects hold still - but an add() did work proportional to every frame already
there, so the page fell further behind a sampler that does not wait:

  * every update script opened its OWN BroadcastChannel and kept it alive with
    a listener, holding its frames, and a post reaches every other open channel
    of the same name - so add() n paid for the n-1 before it (viewer.py,
    _live_post_js: one channel per viewer per document now);
  * _recomputeObjectStats walked every position of every frame (core/mol.js:
    running sums, and an extent that is exact at a reference centre and at most
    0.2% generous as the centre drifts);
  * the scatter plot rebuilt and redrew every point two or three times an
    add() (now once per frame, coalesced).

This builds the notebook's viewer through the Python API (scatter, persistence
off), takes the update script viewer.py EMITS for an add(), and runs it in the
page for each step with only the payload swapped - one document, as Jupyter
has. Then:

  * the update scripts opened ONE channel between them, not one each;
  * fifty add()s with no frame between them drew the scatter plot zero times
    synchronously;
  * the running sums carried over (the same accumulator, all frames counted),
    and the extent is never under the exact value and at most 0.2% over it;
  * with persistence off the channel holds one update, and a viewerReady
    makes it replay exactly that one;
  * ms per add() at ~3,000 frames is under 2.5x that at ~500. Before, the
    per-add channels alone made it 4x by 2,000.
"""
import json, os, re, sys, time, types, threading, shutil
import http.server, socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp  # noqa: E402

try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType("IPython"); disp = types.ModuleType("IPython.display")
    for n in ("display", "HTML", "Javascript", "update_display"):
        setattr(disp, n, lambda *a, **k: None)
    ip.display = disp; ip.get_ipython = lambda: None
    sys.modules["IPython"] = ip; sys.modules["IPython.display"] = disp
sys.path.insert(0, ROOT)
import numpy as np  # noqa: E402
import py2Dmol  # noqa: E402

PORT, DEBUG_PORT = 9975, 9976
OUT = os.path.join(ROOT, "_livestream")
os.makedirs(OUT, exist_ok=True)

L = 34
t = np.linspace(0, 6 * np.pi, L)
ca = np.stack([2.3 * np.cos(t * 1.7), 2.3 * np.sin(t * 1.7), 1.5 * t], 1)
v = py2Dmol.view(scatter=True, persistence=False)
v.new_obj(scatter_config={"xlabel": "Step", "ylabel": "Energy"})
v.add(ca, scatter=[0, 1.0])
v.save_html(os.path.join(OUT, "page.html"))
name = v.objects[-1]["name"]
frame0 = v.objects[-1]["frames"][0]

# The script an add() writes into the notebook, exactly as viewer.py emits it.
emitted = []
v._is_live = True
v._emit_to_output = lambda html, **k: emitted.append((html, k.get("payload_json")))
v.add(ca + 0.5, scatter=[1, 0.9])
v._send_incremental_update()
html, payload_json = emitted[-1]
script = html.split(">", 1)[1].rsplit("</script>", 1)[0]
if not payload_json or payload_json not in script:
    print("FAIL: could not find the payload in the emitted script"); sys.exit(1)
TEMPLATE = script.replace(payload_json, "window.__P", 1)

COUNT_CHANNELS = r"""
window.__channels = 0;
const BC = window.BroadcastChannel;
window.BroadcastChannel = function (n) { if (String(n).startsWith('py2dmol_') && n !== 'py2dmol_lib') window.__channels++; return new BC(n); };
window.BroadcastChannel.prototype = BC.prototype;
"""

PAGE_JS = r"""(async (TEMPLATE, name, base) => {
  const out = {};
  const vid = Object.keys(window.py2dmol_viewers)[0];
  const r = window.py2dmol_viewers[vid].renderer;
  const o = r.objectsData[name];
  const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
  const run = new Function(TEMPLATE);
  let seq = 100;
  const add = (k) => {
    const f = Object.assign({}, base);
    f.coords = base.coords.map((c) => [c[0] + Math.sin(k + c[2]) * 0.8, c[1] + Math.cos(k * 1.3 + c[0]) * 0.8, c[2]]);
    f.scatter = [k, Math.sin(k / 50)];
    window.__P = {seq: ++seq, frames: {[name]: [f]}, meta: {}, viewer: null};
    run();
  };
  const channelsBefore = window.__channels;
  // timed stretches, drawing every 10 adds as a live page would
  const stretch = async (from, n) => {
    const t0 = performance.now();
    for (let k = from; k < from + n; k++) { add(k); if (k % 10 === 0) await raf(); }
    return (performance.now() - t0) / n;
  };
  let k = 2;
  for (; k < 500; k++) { add(k); if (k % 10 === 0) await raf(); }
  out.msAt500 = await stretch(k, 300); k += 300;
  for (; k < 3000; k++) { add(k); if (k % 10 === 0) await raf(); }
  out.msAt3000 = await stretch(k, 300); k += 300;

  // fifty adds, no frame between them: no synchronous scatter draw
  const sr = r.scatterRenderer;
  let draws = 0;
  const real = sr.render;
  sr.render = function () { draws++; return real.apply(this, arguments); };
  for (let j = 0; j < 50; j++) add(k++);
  out.syncScatterDraws = draws;
  sr.render = real;
  await raf(); await raf();

  out.channelsOpenedByUpdates = window.__channels - channelsBefore;
  out.frames = o.frames.length;
  const acc = o._statsAcc;
  out.accCountsAll = !!acc && acc.n === o.frames.length;
  const accBefore = acc;
  add(k++);
  out.accCarried = o._statsAcc === accBefore;

  // the extent against a brute-force walk from the centre
  let tx = 0, ty = 0, tz = 0, n = 0;
  for (const fr of o.frames) for (const c of fr.coords) { tx += c[0]; ty += c[1]; tz += c[2]; n++; }
  const cx = tx / n, cy = ty / n, cz = tz / n;
  let m = 0;
  for (const fr of o.frames) for (const c of fr.coords) m = Math.max(m, Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz));
  out.extentRel = (o.maxExtent - m) / m;

  // replay: one held update, and a viewerReady replays exactly it
  const tx2 = window.__py2dmolTx && window.__py2dmolTx[vid];
  out.held = tx2 ? tx2.held.size : -1;
  const probe = new BroadcastChannel('py2dmol_' + vid);
  let replayed = 0;
  probe.onmessage = (e) => { if (e.data && e.data.operation === 'incrementalStateUpdate') replayed++; };
  probe.postMessage({operation: 'viewerReady', sourceInstanceId: 'probe'});
  await new Promise((res) => setTimeout(res, 300));
  out.replayed = replayed;
  probe.close();
  return out;
})"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=OUT, **k)
    def log_message(s, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
profile = "/tmp/py2dmol-livestream-prof"
chrome, ws = cdp.launch(DEBUG_PORT, profile)
ws.s.settimeout(None)
bad = []
try:
    ws.call("Page.enable")
    ws.call("Page.addScriptToEvaluateOnNewDocument", source=COUNT_CHANNELS)
    ws.call("Emulation.setDeviceMetricsOverride", width=1200, height=900, deviceScaleFactor=1, mobile=False)
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/page.html")
    cdp.wait_for(ws, "!!(window.py2dmol_viewers && Object.keys(window.py2dmol_viewers).length)",
                 timeout=60, what="the viewer")
    expr = "%s(%s, %s, %s)" % (PAGE_JS, json.dumps(TEMPLATE), json.dumps(name),
                               json.dumps(frame0, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o)))
    r = ws.call("Runtime.evaluate", returnByValue=True, awaitPromise=True, expression=expr)
    res = r.get("result", {}).get("value")
    if res is None:
        print(json.dumps(r)[:1500]); sys.exit(1)
finally:
    chrome.kill(); srv.shutdown()
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.rmtree(profile, ignore_errors=True)

print(json.dumps(res))
if res["channelsOpenedByUpdates"] != 1:
    bad.append("the update scripts opened %d channels - one per add() keeps every"
               " update alive and makes each post reach all of them" % res["channelsOpenedByUpdates"])
if res["syncScatterDraws"] != 0:
    bad.append("50 add()s with no frame between drew the scatter plot %d times synchronously"
               % res["syncScatterDraws"])
if not (res["accCountsAll"] and res["accCarried"]):
    bad.append("the stats did not carry their running sums across an append: %s" % res)
if not (-1e-9 <= res["extentRel"] <= 0.002 + 1e-9):
    bad.append("maxExtent is %.4f%% off the exact value - it may only be up to 0.2%% over"
               % (res["extentRel"] * 100))
if res["held"] != 1 or res["replayed"] != 1:
    bad.append("with persistence off the channel should hold and replay one update:"
               " held %s, replayed %s" % (res["held"], res["replayed"]))
if res["msAt3000"] > 2.5 * res["msAt500"]:
    bad.append("an add() at ~3,000 frames costs %.2f ms against %.2f at ~500 - it grows"
               " with the frames already there" % (res["msAt3000"], res["msAt500"]))
if bad:
    for b in bad:
        print("FAIL " + b)
    sys.exit(1)
print("ok")
