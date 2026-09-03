"""The play button has to survive being pressed WHILE IT IS PLAYING.

    python3 tests/play_stop.py            # 1YNE, an NMR ensemble, on dev.html
    python3 tests/play_stop.py 1YNE.cif

🔴 REPORTED AS: pressing play to stop does not always respond, and you have to
click several times.

The mechanism is not in the handler, which is a two-line `togglePlay`. It is in
`updateUIControls`, which the frame-advance timer calls on EVERY tick - 100 ms
at 1x, 25 ms at 4x - and which used to set

    this.playButton.innerHTML = '<i class="fa-solid fa-pause"></i>'

unconditionally. That DESTROYS the <i> the pointer went down on and builds a
fresh one. Chrome fires `click` only when mousedown and mouseup share a live
common ancestor, so a tick landing between a human's press and release - about
100 ms, which is most of them - swallows the press entirely. The faster you
play, the worse it is, which is the tell that it is the tick and not the
handler. The record button eight lines below has always assigned
`icon.className` instead, which is why only Play had the fault.

Two legs, and they answer different questions:

  IDENTITY is the mechanism and is deterministic - play, hold a reference to
  the <i>, let several ticks pass, and require it to be the SAME NODE, still
  in the document. Nothing about timing, so it cannot flake.

  THE GESTURE is the report - a real CDP press and release with a tick
  guaranteed to land between them, repeated, counting how many presses the
  page swallowed. This is the one that speaks the reader's language, and it
  needs real Input events: dispatching MouseEvent objects from script does not
  go through the browser's click synthesis at all, so it would pass against
  the bug.

The control is the FIRST press, which starts playback: if that does not work
the page is broken in some other way and "it stopped" would pass for the wrong
reason.
"""
import http.server, os, re, shutil, socketserver, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_playstop.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1YNE.cif"
PORT = int(os.environ.get("PORT", "9781"))
CDP = int(os.environ.get("CDPPORT", "9481"))
# Presses to try. The fault is probabilistic for a human and CERTAIN here,
# because the release is held back past a tick deliberately - so one swallowed
# press is a failure, not a flake.
TRIES = 4


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


def main():
    # dev.html, so this measures the WORKING TREE. index.html loads the built
    # bundle, and a probe against it scores whatever was last committed there -
    # which is how the first run of this one reported the bug as still present
    # after it had been fixed in src/core/mol.js.
    src = open(os.path.join(ROOT, "dev.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src)
    httpd = serve(PORT)
    prof = f"/tmp/py2dmol-playstop-{os.getpid()}"
    proc, ws = launch(CDP, prof)
    bad = []
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        # 🔴 A TALL VIEWPORT, OR THE PRESS LANDS ON NOTHING. Input events are in
        # VIEWPORT coordinates, and index.html puts the play strip at y = 950 in
        # a window headless opens at 469 high - so `elementFromPoint` at the
        # button's own rect answered null and the first press simply missed. The
        # probe reported "the first press did not start playback", which is what
        # a broken page looks like and had nothing to do with the page.
        ws.call("Emulation.setDeviceMetricsOverride", width=1200, height=1500,
                deviceScaleFactor=1, mobile=False)
        ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_playstop.html")
        wait_for(ws, "typeof window.processFiles === 'function'", 60, "app")
        # An NMR ensemble is many models in one file; loadAsFrames stacks them.
        n = evaluate(ws, f"""(async () => {{
            const raf = () => new Promise((s) => requestAnimationFrame(s));
            const txt = await (await fetch('/{FILE}')).text();
            await window.processFiles([{{name: '{FILE}',
                readAsync: () => Promise.resolve(txt)}}], true);
            const v = window.py2dmol_viewers[
                Object.keys(window.py2dmol_viewers)[0]];
            const r = v.renderer;
            for (let k = 0; k < 200 && !(r.coords && r.coords.length); k++) await raf();
            window.__r = r;
            const o = r.objectsData[r.currentObjectName];
            return o ? o.frames.length : 0;
        }})()""")
        print(f"  {FILE}: {n} frames")
        if not n or n < 2:
            bad.append(f"{FILE} loaded as {n} frame(s) - with one frame the play"
                       " strip is display:none and nothing here is tested")
            raise SystemExit
        # 4x, so a tick is 25 ms and the release below cannot miss one.
        evaluate(ws, """(() => {
            const r = window.__r;
            r.animationSpeed = 25;
            r.speedIndex = r.speedOptions.indexOf(25);
            return r.animationSpeed;
        })()""")

        box = evaluate(ws, """(() => {
            const b = document.getElementById('playButton');
            if (!b) return null;
            b.scrollIntoView({block: 'center'});
            const i = b.querySelector('i');
            const t = (i || b).getBoundingClientRect();
            const x = t.left + t.width / 2; const y = t.top + t.height / 2;
            // ...and check that something is actually THERE, which is the
            // check whose absence cost the round described above.
            const hit = document.elementFromPoint(x, y);
            return {x, y, hasIcon: !!i,
                    onButton: !!(hit && (hit === b || b.contains(hit)))};
        })()""")
        if not box:
            bad.append("no #playButton on index.html")
            raise SystemExit
        if not box.get("onButton"):
            bad.append(f"nothing is at the play button's own centre"
                       f" ({box['x']:.0f}, {box['y']:.0f}) - the press would"
                       " land on empty page and every leg below would fail for"
                       " that reason and not for the bug")
            raise SystemExit
        if not box["hasIcon"]:
            bad.append("#playButton has no <i> child - this probe is written"
                       " for the icon shell, which is the one that had the bug")
            raise SystemExit

        def press(hold_ms):
            """A real press and release, with the release held back past a tick."""
            for typ in ("mousePressed", "mouseReleased"):
                if typ == "mouseReleased":
                    time.sleep(hold_ms / 1000.0)
                ws.call("Input.dispatchMouseEvent", type=typ,
                        x=box["x"], y=box["y"], button="left", clickCount=1,
                        buttons=1 if typ == "mousePressed" else 0)

        # THE CONTROL: a press that starts playback. Held only briefly, so no
        # tick can land - nothing is playing yet, so there is no timer at all.
        press(20)
        time.sleep(0.3)
        playing = evaluate(ws, "!!window.__r.isPlaying")
        print(f"  press 1 (start): isPlaying = {playing}")
        if not playing:
            bad.append("the first press did not start playback, so the page is"
                       " broken in some other way and every result below would"
                       " pass or fail for the wrong reason")
            raise SystemExit

        # LEG 1 - IDENTITY. Let several ticks go by and ask whether the node
        # the pointer would have gone down on is still the node it would come
        # up on. Deterministic: no press, no timing window.
        ident = evaluate(ws, """(async () => {
            const b = document.getElementById('playButton');
            const before = b.querySelector('i');
            const wait = (ms) => new Promise((s) => setTimeout(s, ms));
            await wait(300);                       // ~12 ticks at 25 ms
            const after = b.querySelector('i');
            return {same: before === after,
                    stillIn: document.contains(before),
                    cls: after ? after.className : null};
        })()""")
        print(f"  after ~12 ticks: same <i> node = {ident['same']},"
              f" still in the document = {ident['stillIn']},"
              f" class {ident['cls']!r}")
        if not (ident["same"] and ident["stillIn"]):
            bad.append("the play button's <i> is REPLACED while it plays. That"
                       " is the whole fault: a tick landing between a press and"
                       " a release detaches the mousedown target and Chrome"
                       " fires no click. Mutate the icon's className instead,"
                       " the way the record button does - see updateUIControls"
                       " in src/core/mol.js")

        # LEG 2 - THE GESTURE. Press, hold past a tick, release. Every one of
        # these must land.
        swallowed = []
        for k in range(TRIES):
            want = evaluate(ws, "!!window.__r.isPlaying")
            press(120)                             # ~5 ticks held down
            time.sleep(0.3)
            got = evaluate(ws, "!!window.__r.isPlaying")
            if got == want:
                swallowed.append(k + 1)
            print(f"  press {k + 2}: isPlaying {want} -> {got}"
                  f"{'   SWALLOWED' if got == want else ''}")
        if swallowed:
            bad.append(f"{len(swallowed)} of {TRIES} presses did nothing"
                       f" (presses {swallowed}) - each was held down across"
                       " several frame ticks, which is what a human click does."
                       " This is the reported symptom: having to click the play"
                       " button several times to make it stop")
    except SystemExit:
        pass
    finally:
        proc.kill()
        httpd.shutdown()
        shutil.rmtree(prof, ignore_errors=True)
        try:
            os.remove(PROBE)
        except OSError:
            pass

    for m in bad:
        print("FAIL:", m)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
