"""THIS TREE AGAINST origin/main, on the ordinary path: every frame rebuilds.

    git worktree add /tmp/py2dmol-base origin/main
    python3 tests/against_baseline.py                    # a step, and a load
    python3 tests/against_baseline.py --root=/tmp/py2dmol-base   # one arm alone

The fast path is not what this measures. Every frame rebuilds its assignment,
its faces and its mesh, which is what a reader gets on the ordinary path - and
the path all this session's work had to leave alone or improve on its own terms.
the station table used to be able to switch that off from here; it has been removed.

🔴 THE ARMS ARE TWO CHECKOUTS, SO THEY CANNOT SHARE A PROCESS. Everything else
in tests/ interleaves its arms inside one page because this machine drifts by
up to 3.2x; here the arms are two different copies of src/, so each needs its
own server and its own Chrome. The compensation is ROUNDS: the two are run
alternately, whole, several times over, and the median of each is taken. A
single pass of A then B measures the drift and nothing else.

🔴 AND EVERY CALL INTO THE APP IS GUARDED. The baseline is 135 commits back and
does not have the station path, `setStationDraw`, or several of the fields the
current probes read. A probe that throws on the old tree reports the new one as
infinitely faster.
"""
import json, os, sys, shutil, statistics, subprocess, http.server
import socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASE = "/tmp/py2dmol-base"
ROUNDS = 3
STEPS = 40
FILE = "_traj_1tim.pdb"
LOAD = "1AOI.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, loadFile, steps) => {
   try {
    // ---- THE LOAD, timed from the drop to a drawn cartoon ---------------
    const t0 = performance.now();
    const lt = await (await fetch('/' + loadFile)).text();
    await window.processFiles(
      [{name: loadFile, readAsync: () => Promise.resolve(lt)}], true);
    await until(loaded, 300000);
    const r0 = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r0.coords && r0.coords.length > 0, 300000);
    if (r0.setStyle) r0.setStyle('cartoon'); else r0.style = 'cartoon';
    await settle(10);
    await until(() => !r0._quietStyle && !r0._switchQuiet, 60000);
    const loadMs = performance.now() - t0;

    // ---- THE STEP, with the fast path explicitly OFF --------------------
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    // a few steps first, so a compile or a first-frame allocation lands
    for (let i = 0; i < 6; i += 1) { r.setFrame(i % frames); r.render(); }
    // 🔴 AND HOW MANY OF THOSE STEPS ACTUALLY REBUILT. A step that reuses a
    // mesh is not the same measurement as one that builds it, and if the two
    // arms reuse at different rates the ratio below is about the reuse and not
    // about the code.
    //
    // 🔴 NOT `__faceBuilds`, WHICH THE BASELINE DOES NOT HAVE. It was added in
    // this session's own work, so it reads 0 there forever and reports the old
    // tree as never rebuilding - which is the opposite of the truth and would
    // have turned a fair 1.4x into a story about reuse. `__rebuild.t0` is
    // stamped by both trees at the top of every mesh build.
    const stamp = () => {
      const R = window.__rebuild;
      return (R && R.t0 !== undefined) ? R.t0 : -1;
    };
    let last = stamp();
    let sawStamp = last !== -1;
    let builds = 0;
    const each = []; const built = []; const reused = [];
    for (let i = 0; i < steps; i += 1) {
      const a = performance.now();
      r.setFrame(i % frames);
      r.render();
      const ms = performance.now() - a;
      each.push(ms);
      const st = stamp();
      // ...and this step's cost filed under what it actually did. A step that
      // reuses a mesh and one that builds it are two different measurements,
      // and their blend hides which of the two moved.
      if (st !== last) { last = st; builds += 1; built.push(ms); }
      else reused.push(ms);
    }
    const med = (xs) => {
      if (!xs.length) return -1;
      const c = xs.slice().sort((x, y) => x - y);
      return +c[(c.length / 2) | 0].toFixed(2);
    };
    each.sort((x, y) => x - y);
    // 🔴 A LATCH, NOT A FINAL READ. Asking whether the stamp exists AFTER the
    // loop says nothing about whether it existed during it - the baseline
    // clears __rebuild in places - and the check then failed a run whose
    // rebuild count it had just printed as 40 of 40.
    return {builds, sawStamp, loadMs: +loadMs.toFixed(1),
            builtMedian: med(built), reusedMedian: med(reused),
            stepMedian: +each[(each.length / 2) | 0].toFixed(2),
            stepMin: +each[0].toFixed(2),
            positions: r.coords.length, frames,
            };
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)


def run(root, port, dport, tag):
    probe = os.path.join(root, "_baseline.html")
    src = os.path.join(root, "dev.html")
    open(probe, "w").write(
        open(src).read().replace("</body>", "<script>" + SETUP + "</script></body>"))

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=root, **k)

        def log_message(self, *a):
            pass

    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    pdir = f"/tmp/py2dmol-baseline-{tag}"
    chrome, ws = cdp.launch(dport, pdir)
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        ws.call("Page.navigate", url=f"http://127.0.0.1:{port}/_baseline.html")
        cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page")
        out = json.loads(cdp.evaluate(
            ws, f"window.__go({json.dumps(FILE)}, {json.dumps(LOAD)},"
                f" {STEPS}).then(JSON.stringify)"))
    finally:
        chrome.kill(); httpd.shutdown()
        try: os.remove(probe)
        except OSError: pass
        shutil.rmtree(pdir, ignore_errors=True)
    return out


only = None
for a in sys.argv[1:]:
    if a.startswith("--root="):
        only = a.split("=", 1)[1]

if only:
    print(json.dumps(run(only, 9931, 9932, "one"), indent=2))
    sys.exit(0)

if not os.path.isdir(BASE):
    sys.exit(f"{BASE} is not there - `git worktree add {BASE} origin/main` first")

rows = {"this tree": [], "origin/main": []}
keep = {}
for i in range(ROUNDS):
    # alternated, whole, so the drift lands in both
    a = run(ROOT, 9931, 9932, "head")
    b = run(BASE, 9933, 9934, "base")
    for name, out in (("this tree", a), ("origin/main", b)):
        if out.get("error"):
            print(f"  round {i}: {name}: {out['error'][:200]}")
            continue
        rows[name].append(out)

bad = []
print(f"\n{FILE}, cartoon, the station table OFF - {STEPS} steps a round,"
      f" {ROUNDS} rounds each\n")
for name in ("this tree", "origin/main"):
    rs = rows[name]
    if not rs:
        bad.append(f"{name} produced no measurement at all")
        continue
    step = statistics.median([r["stepMedian"] for r in rs])
    mn = min(r["stepMin"] for r in rs)
    load = statistics.median([r["loadMs"] for r in rs])
    bl = statistics.median([r.get("builds", -1) for r in rs])
    if not all(r.get("sawStamp") for r in rs):
        bad.append(f"{name} never showed a window.__rebuild stamp, so the"
                   " rebuild count below is not a count of anything")
    print(f"  {name:<12} {bl:>4.0f} of {STEPS} steps rebuilt")
    print(f"  {name:<12} step {step:>6.2f} ms (min {mn:.2f}),"
          f" {LOAD} load {load:>7.0f} ms,"
          f" {rs[0]['positions']} positions")
    bmed = [r["builtMedian"] for r in rs if r["builtMedian"] > 0]
    rmed = [r["reusedMedian"] for r in rs if r["reusedMedian"] > 0]
    print(f"  {'':<12}   of which: a step that REBUILT"
          f" {statistics.median(bmed) if bmed else float('nan'):>6.2f} ms,"
          f" one that reused"
          f" {statistics.median(rmed) if rmed else float('nan'):>6.2f} ms")
    keep[name] = (bmed, rmed)

if rows["this tree"] and rows["origin/main"]:
    a = statistics.median([r["stepMedian"] for r in rows["this tree"]])
    b = statistics.median([r["stepMedian"] for r in rows["origin/main"]])
    la = statistics.median([r["loadMs"] for r in rows["this tree"]])
    lb = statistics.median([r["loadMs"] for r in rows["origin/main"]])
    print(f"\n  step  {b:.2f} -> {a:.2f} ms   ({b / max(a, 1e-9):.2f}x)")
    ba, _ = keep.get("this tree", ([], []))
    bb, _ = keep.get("origin/main", ([], []))
    if ba and bb:
        x = statistics.median(bb); y = statistics.median(ba)
        print(f"  build {x:.2f} -> {y:.2f} ms   ({x / max(y, 1e-9):.2f}x)"
              "   the same work, done faster")
    print(f"  load  {lb:.0f} -> {la:.0f} ms   ({lb / max(la, 1e-9):.2f}x)")

print()
for x in bad:
    print("FAIL: " + x)
print("baseline: " + ("FAILED" if bad else "measured"))
sys.exit(1 if bad else 0)
