"""Zoom, filmed: how choppy is a zoom gesture, frame to frame.

Same instrument as the one that caught the heatmap's black frame - a REAL
headed Chrome under Page.startScreencast - and for the same reason: headless
composites through SwiftShader, so what it tells you about smoothness is
about SwiftShader. Two clocks are read, because they answer different
questions:

  raf      the page's own requestAnimationFrame timestamps. What the PAGE
           managed to do. A long gap here is the main thread busy.
  cast     the deltas between screencast frames. What the COMPOSITOR put on
           the screen. The screencast only sends a frame when the surface
           changed, so its count is <= raf's; a gap here with no gap in raf
           is a frame the page drew and the compositor did not present.

The gesture is real Input.dispatchMouseEvent wheels over the canvas centre -
page script cannot make a wheel the app's own listener treats as trusted, and
this is measuring the whole path.

  python3 scratchpad/zoomcast.py [FILE.cif] [--pdb=3J3Y] [--n=60] [--hz=30]

🔴 ws.call() DROPS EVENTS. It reads until it sees its own id and throws the
rest away, so nothing may call it while the screencast is running: the frames
would go in the bin. During the capture this pumps recv() itself and matches
replies by id.
"""
import http.server, json, os, re, socketserver, subprocess, sys, threading, time
import shutil, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
from cdp import WS, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_zoomcast.html")
PORT = int(os.environ.get("PORT", "9799"))
CDP = int(os.environ.get("CDPPORT", "9499"))

args = [a for a in sys.argv[1:]]
opt = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1]
       for a in args if a.startswith("--") and "=" in a}
FILE = next((a for a in args if not a.startswith("--")), "1AOI.cif")
PDB = opt.get("pdb")
N = int(opt.get("n", "60"))
HZ = float(opt.get("hz", "30"))


def serve(port):
    socketserver.ThreadingTCPServer.allow_reuse_address = True

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, *a):
            pass

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def launch_headed(port, profile):
    """A HEADED browser, deliberately. The thing being measured is the
    compositor, and headless has a different one."""
    subprocess.run(["pkill", "-9", "-f", "user-data-dir=" + profile],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(profile, ignore_errors=True)
    p = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
        "--window-size=" + os.environ.get("WIN", "1200,900"), "--window-position=40,40",
        "--remote-debugging-port=%d" % port, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + 30
    while time.time() < end:
        try:
            js = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port))
            for t in js:
                if t.get("type") == "page":
                    return p, WS(t["webSocketDebuggerUrl"])
        except Exception:
            time.sleep(0.3)
    p.kill()
    raise RuntimeError("no CDP target")


RAF_JS = """
window.__raf = []; window.__rafOn = true;
(function tick(t) { if (window.__rafOn) { window.__raf.push(t);
  requestAnimationFrame(tick); } })(performance.now());
"""


def stats(xs):
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return {"n": n, "median": s[n // 2], "p90": s[int(n * 0.9)], "worst": s[-1],
            "over33": sum(1 for v in s if v > 33.0),
            "over50": sum(1 for v in s if v > 50.0)}


def main():
    src = open(os.path.join(ROOT, "dev.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src)
    httpd = serve(PORT)
    prof = "/tmp/py2dmol-zoomcast-%d" % os.getpid()
    proc, ws = launch_headed(CDP, prof)
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        ws.call("Page.navigate", url="http://127.0.0.1:%d/_zoomcast.html" % PORT)
        wait_for(ws, "typeof window.processFiles === 'function'", 60, "app")

        if PDB:
            load = ("const txt = await (await fetch("
                    "'https://files.rcsb.org/download/%s.cif')).text();"
                    "const name = '%s.cif';" % (PDB, PDB))
        else:
            load = ("const txt = await (await fetch('/%s')).text();"
                    "const name = '%s';" % (FILE, FILE))
        # 🔴 A 200 MB STRUCTURE OUTLIVES ANY ONE EVALUATE. The load is
        # started and the flag is polled, rather than awaited in place: an
        # awaitPromise that runs for minutes comes back as a dead socket and
        # reads as a broken page.
        evaluate(ws, """(() => { window.__done = null; (async () => {
            %s
            await window.processFiles([{name: name,
                readAsync: () => Promise.resolve(txt)}], false);
            const v = window.py2dmol_viewers[
                Object.keys(window.py2dmol_viewers)[0]];
            const r = v.renderer;
            const raf = () => new Promise((s) => requestAnimationFrame(s));
            for (let k = 0; k < 3000 && !(r.coords && r.coords.length); k++) await raf();
            window.__r = r;
            for (let k = 0; k < 60; k++) await raf();
            const c = r.canvas.getBoundingClientRect();
            window.__done = {n: r.coords.length, name: name, gpu: !!r.useGPU,
                    dpr: window.devicePixelRatio,
                    css: Math.round(c.width) + 'x' + Math.round(c.height),
                    px: r.canvas.width + 'x' + r.canvas.height,
                    cx: Math.round(c.left + c.width / 2),
                    cy: Math.round(c.top + c.height / 2)};
        })().catch((e) => { window.__done = {err: String(e)}; }); })()""" % load,
                 False)
        wait_for(ws, "!!window.__done", 1800, "the structure to load")
        info = evaluate(ws, "window.__done")
        if info.get("err"):
            raise RuntimeError(info["err"])
        print("loaded %s: %d positions, gpu=%s, dpr %s, canvas %s css / %s px"
              % (info["name"], info["n"], info["gpu"], info["dpr"],
                 info["css"], info["px"]))

        if "size" in opt:
            # 🔴 THE FULL-SCREEN BUTTON NEEDS A TRUSTED CLICK, so the box is
            # written instead - which is what render.html does, and
            # setupViewport's ResizeObserver does the rest. The pixel count is
            # most of what a zoom costs, so measuring at the default 598px box
            # says nothing about a viewer filling a retina screen.
            evaluate(ws, """(async () => {
                const el = document.getElementById('canvasContainer');
                el.style.width = '%spx'; el.style.height = '%spx';
                const raf = () => new Promise((s) => requestAnimationFrame(s));
                for (let k = 0; k < 90; k++) await raf();
            })()""" % (opt["size"], opt["size"]))
            info.update(evaluate(ws, """(() => { const r = window.__r;
                const c = r.canvas.getBoundingClientRect();
                return {css: Math.round(c.width) + 'x' + Math.round(c.height),
                        px: r.canvas.width + 'x' + r.canvas.height,
                        cx: Math.round(c.left + c.width / 2),
                        cy: Math.round(c.top + c.height / 2)}; })()"""))
            print("resized: canvas %s css / %s px" % (info["css"], info["px"]))

        # Counters the renderer already keeps, so a stall can be attributed
        # rather than guessed at.
        before = evaluate(ws, "window.__faceBuilds || 0")

        evaluate(ws, RAF_JS, False)
        ws.call("Page.startScreencast", format="jpeg", quality=40,
                everyNthFrame=1, maxWidth=900, maxHeight=700)

        frames = []          # (wall clock ms, compositor timestamp s)
        pending = {}
        msgid = [ws.id]

        def send(method, **params):
            msgid[0] += 1
            ws.send({"id": msgid[0], "method": method, "params": params})
            pending[msgid[0]] = method
            return msgid[0]

        def pump(until_t):
            """Read everything the browser says until a deadline, keeping the
            screencast frames and acking them."""
            while time.time() < until_t:
                ws.s.settimeout(max(0.01, until_t - time.time()))
                try:
                    m = ws.recv()
                except Exception:
                    return
                if m.get("method") == "Page.screencastFrame":
                    md = m["params"].get("metadata", {})
                    frames.append((time.time() * 1000.0, md.get("timestamp")))
                    send("Page.screencastFrameAck",
                         sessionId=m["params"]["sessionId"])
                elif "id" in m:
                    pending.pop(m["id"], None)

        # Settle: let the screencast start and the page go quiet.
        pump(time.time() + 1.0)
        frames.clear()

        cx, cy = info["cx"], info["cy"]
        t0 = time.time()
        gesture0 = t0
        for i in range(N):
            # In for the first half, out for the second - one full trip, which
            # is the gesture that was reported.
            dy = -120 if i < N // 2 else 120
            send("Input.dispatchMouseEvent", type="mouseWheel", x=cx, y=cy,
                 deltaX=0, deltaY=dy, modifiers=0)
            pump(gesture0 + (i + 1) / HZ)
        gesture_end = time.time()
        pump(gesture_end + 0.6)      # the tail: frames still in flight
        ws.s.settimeout(60)
        after = evaluate(ws, """(() => { const r = window.__r;
            const lay = r.canvas.parentNode.querySelector('canvas[data-py2dmol-layer]');
            return {latchNow: r._gestureScaleLatch || 0,
                    layer: lay ? lay.width + 'x' + lay.height : null,
                    canvas: r.canvas.width + 'x' + r.canvas.height}; })()""")
        print("after the gesture: %s" % json.dumps(after))
        evaluate(ws, "window.__rafOn = false;", False)
        raf = evaluate(ws, "window.__raf")
        ws.call("Page.stopScreencast")
        after = evaluate(ws, "window.__faceBuilds || 0")

        # Only the frames inside the gesture count; the settle either side is
        # a different workload.
        g0, g1 = t0 * 1000.0, gesture_end * 1000.0
        cast = [b[0] for b in frames if g0 <= b[0] <= g1 + 300]
        cdel = [cast[i] - cast[i - 1] for i in range(1, len(cast))]
        rz = evaluate(ws, "window.__raf.length")
        # rAF timestamps are page-relative (performance.now), so align by
        # taking the last (len(cast)-ish) - simpler: take the whole tail that
        # covers the same duration.
        dur = (g1 - g0)
        rt = [t for t in raf if t >= raf[-1] - (dur + 300)] if raf else []
        rdel = [rt[i] - rt[i - 1] for i in range(1, len(rt))]

        print("gesture: %d wheels over %.2f s" % (N, (g1 - g0) / 1000.0))
        print("mesh builds during it: %d" % (after - before))
        print("raf  frames %s" % json.dumps(stats(rdel)))
        print("cast frames %s" % json.dumps(stats(cdel)))
        if cdel:
            slow = sorted(range(len(cdel)), key=lambda i: -cdel[i])[:6]
            print("worst cast gaps (ms, at s into gesture): %s"
                  % ", ".join("%.0f@%.2f" % (cdel[i], (cast[i + 1] - g0) / 1000.0)
                              for i in sorted(slow)))
        _ = rz
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        httpd.shutdown()
        if os.path.exists(PROBE):
            os.remove(PROBE)


main()
