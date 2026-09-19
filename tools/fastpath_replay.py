"""Replay a saved session on the station fast path and compare every step
against a fresh build of the same frame.

    python3 tools/fastpath_replay.py SESSION.json [--base=all|N] [--zoom=2.5]
        [--sidechains] [--detail=N] [--pencil=0] [--out=DIR] [--url=URL]

WHAT IT MEASURES. The station fast path keeps the mesh (faces, pieces, edge
table) of the frame it was BUILT at and only rewrites station geometry on each
step. A fault there shows as a frame that differs from a rebuild of itself. So:

  1. every frame is built fresh once and its pixels kept (the reference);
  2. for each BASE frame b: build at b, then step through every other frame on
     the fast path, and diff each against its reference.

The base matters: a line from a stale weld appears only when the mesh was
built at a frame where the strand was broken (in the session this was written
for, base 1 showed ~160 px on every later frame and base 0 showed nothing).
`--base=all` tries every base; it is O(frames^2) renders, a few minutes for 25.

TWO COUNTS PER STEP:
  darker - pixels the fast frame makes darker than the reference by >120 summed
           over RGB. A missing outline cannot do this; an EXTRA stroke can. Tie-
           break noise at arrow ends is ~20-60 of these; a real line is 100+.
  missing - pixels the fast frame makes LIGHTER by the same margin: something
           the reference draws that the fast frame lost (a vanished face, a
           dropped outline).
A step that REBUILT is skipped and counted: it measured a build, not the path.

It serves the py2Dmol checkout (dev.html, so the working tree is what runs)
unless --url names another page with the full bundle (LocalFold's index.html
works). The session is fetched as /<basename> from that server's root, so
copy it there first when --url is used.

Writes the worst step's fast and fresh PNGs into --out (default
/tmp/fastpath_replay).
"""
import argparse, base64, functools, http.server, io, json, os, shutil, socketserver, sys, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("session")
ap.add_argument("--base", default="all")
ap.add_argument("--zoom", type=float, default=1.0)
ap.add_argument("--sidechains", action="store_true")
ap.add_argument("--detail", type=int, default=0)
ap.add_argument("--pencil", type=float, default=0.0,
                help="the grain is noise laid over what is compared; -1 keeps the session's")
ap.add_argument("--out", default="/tmp/fastpath_replay")
ap.add_argument("--url", default=None)
ap.add_argument("--port", type=int, default=9985)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)

name = os.path.basename(a.session)
copied = None
if a.url is None:
    dst = os.path.join(ROOT, name)
    if os.path.realpath(a.session) != os.path.realpath(dst):
        shutil.copy(a.session, dst); copied = dst
    http.server.SimpleHTTPRequestHandler.log_message = lambda *x: None
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", a.port), functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=ROOT))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{a.port}/dev.html"
else:
    httpd = None
    url = a.url

JS = """(async () => {
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  const st = await (await fetch('/%NAME%')).json();
  await until(() => window.py2dmol_viewers && Object.keys(window.py2dmol_viewers).length, 30000);
  await window.loadViewerState(st);
  const r = Object.values(window.py2dmol_viewers)[0].renderer;
  await until(() => r.coords && r.coords.length > 0, 30000);
  await settle(10);
  r.autoRotate = false;
  if (%PENCIL% >= 0) r.cartoonPencil = %PENCIL%;
  if (%DETAIL% > 0) r.cartoonDetail = %DETAIL%;
  if (%SIDE%) { r.showSidechains(); await settle(6); }
  r.viewerState.zoom = %ZOOM%;
  if (G.setStationDraw) G.setStationDraw(true);
  r.render('setup'); await settle(4);
  const nF = r.objectsData[r.currentObjectName].frames.length;
  const px = () => { const c = r.canvas; return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
  const fresh = {};
  for (let f = 0; f < nF; f++) {
    r.setFrame(f); if (G.invalidate) G.invalidate(); if (G.setStationDraw) G.setStationDraw(true); r.render('fresh'); await settle(3); fresh[f] = px();
  }
  const bases = '%BASE%' === 'all' ? [...Array(nF).keys()] : [Number('%BASE%')];
  const rows = []; let worst = {score: -1}; let rebuilt = 0;
  for (const b of bases) {
    r.setFrame(b); if (G.invalidate) G.invalidate(); if (G.setStationDraw) G.setStationDraw(true); r.render('base'); await settle(3);
    for (let k = 1; k < nF; k++) {
      const f = (b + k) % nF;
      const b0 = window.__faceBuilds || 0;
      if (G.setStationDraw) G.setStationDraw(true);
      r.setFrame(f); await settle(3);
      if ((window.__faceBuilds || 0) !== b0) {
        rebuilt++;
        rows.push([b, f, null, null, String(G.stationDecline ? G.stationDecline() : '')]);
        continue;
      }
      const p = px(), q = fresh[f]; let darker = 0, missing = 0;
      for (let i = 0; i < p.length; i += 4) {
        const d = (q[i] + q[i+1] + q[i+2]) - (p[i] + p[i+1] + p[i+2]);
        if (d > 120) darker++; else if (d < -120) missing++;
      }
      rows.push([b, f, darker, missing]);
      if (darker + missing > worst.score) worst = {score: darker + missing, b, f, fast: r.canvas.toDataURL()};
    }
  }
  if (worst.score >= 0) {
    r.setFrame(worst.f); if (G.invalidate) G.invalidate(); r.render('fresh'); await settle(3);
    worst.fresh = r.canvas.toDataURL();
  }
  return JSON.stringify({nF, rows, rebuilt, worst, canvas: [r.canvas.width, r.canvas.height]});
})()"""
JS = (JS.replace("//HELPERS", HELPERS).replace("%NAME%", name).replace("%BASE%", a.base)
      .replace("%ZOOM%", str(a.zoom)).replace("%SIDE%", "true" if a.sidechains else "false")
      .replace("%DETAIL%", str(a.detail)).replace("%PENCIL%", str(a.pencil)))

chrome = None
try:
    chrome, ws = cdp.launch(a.port + 1, "/tmp/py2dmol-fastpath-replay")
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Emulation.setDeviceMetricsOverride", width=1400, height=1100,
            deviceScaleFactor=1, mobile=False)
    ws.call("Page.navigate", url=url)
    cdp.wait_for(ws, "typeof window.loadViewerState === 'function'", timeout=120, what="the page")
    o = json.loads(cdp.evaluate(ws, JS))
finally:
    if chrome: chrome.kill()
    shutil.rmtree("/tmp/py2dmol-fastpath-replay", ignore_errors=True)
    if httpd: httpd.shutdown()
    if copied: os.remove(copied)

rows = o["rows"]
measured = [x for x in rows if x[2] is not None]
print(f"{o['nF']} frames, canvas {o['canvas']}, {len(measured)} fast steps measured,"
      f" {o['rebuilt']} steps rebuilt (skipped)")
for x in sorted(measured, key=lambda x: -(x[2] + x[3]))[:12]:
    print(f"  base {x[0]:3d} -> frame {x[1]:3d}: darker {x[2]:5d}  missing {x[3]:5d}")
declines = {}
for x in rows:
    if x[2] is None: declines[x[4][:90]] = declines.get(x[4][:90], 0) + 1
for why, n in sorted(declines.items(), key=lambda kv: -kv[1])[:5]:
    print(f"  rebuilt x{n}: {why}")
w = o["worst"]
if w.get("fast"):
    for k in ("fast", "fresh"):
        open(os.path.join(a.out, f"worst_b{w['b']}_f{w['f']}_{k}.png"), "wb").write(
            base64.b64decode(w[k].split(",")[1]))
    print(f"worst: base {w['b']} -> frame {w['f']}, images in {a.out}")
