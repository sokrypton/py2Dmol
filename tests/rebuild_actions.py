"""WHAT A SESSION REBUILDS, ACTION BY ACTION, AND WHY.

    python3 tests/rebuild_actions.py [1UBQ.cif]

tests/topology_survey.py and tests/station_controls.py cover the style panel's
sliders. This one covers what someone actually DOES to a structure - turn it,
zoom, select, hover, show a side chain, change the colours, hide the backbone -
and reports the mesh rebuilds each of those costs.

A rebuild here is not automatically wrong: showing a side chain really does add
geometry. What this file is for is the ones that ARE wrong, and it names the
reason for every one of them through stationDecline(), so a rebuild is a
sentence rather than a number.

🔴 THE STATION PATH IS ON, because that is the interesting case and because the
answer differs: without a table every geometry change is a rebuild by
definition, and this file would only be measuring that.

🔴 AND TURNING AND ZOOMING MUST COST NOTHING. The mesh is in model space and the
camera is a uniform - that is the whole design - so those two rows are held to
zero rebuilds rather than reported. They were the first thing this found.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_rebuildactions.html")
PORT = 9811
DEBUG_PORT = 9812
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

# actions that must not rebuild at all, whatever else this file reports
MUST_BE_FREE = {"rotate", "zoom", "select", "clear selection", "hover",
                "outline on", "outline off", "colour scheme", "shade",
                "idle after changes", "fade", "smooth", "highlight",
                "pencil", "clip near", "clip far", "ortho"}

# ...and these may rebuild, but must not rebuild THE RIBBON. Showing a side
# chain adds 114 faces to part 2 and touches not one of the ribbon's 1019, and
# makeResident keeps that part against a hash of its own faces. If this starts
# failing, a term that has nothing to do with the ribbon has got into that hash
# - which is what the palette slot was deliberately kept out of it for.
MUST_REUSE_RIBBON = {"side chains on", "side chains off"}

# 🔴 AND THIS ONE MUST NOT BUILD AT ALL. Hiding the side chains again returns
# to the picture this page had two steps ago, and the renderer keeps one spare
# mesh against its signature - so it should be handed back rather than built.
#
# It used to be built, on any page with ONE object: the spare slot was switched
# on only past two objects, on the grounds that a single-object viewer "has no
# eye to switch". The eye is not the only thing that comes back. Measured on
# 1UBQ before the change, seven alternating toggles cost seven rebuilds; after
# it, two.
#
# ASSERTED HERE AND NOT IN tests/rebuild_returns.py, which is the natural home
# for it and cannot test it: that file loads two objects so it has one to hide,
# so the flag is on there whatever it is gated on. This file loads one
# structure and nothing else.
MUST_COME_BACK = {"side chains off"}

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 120000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const G = window.py2dmolCartoonGPU;
    G.setStationDraw(true);
    if (G.invalidate) G.invalidate();
    r.render('actionsWarm'); await settle(6);

    // HOW MUCH OF THE FRAME IS DRAWN ON, so an action that costs no rebuild
    // can still be shown to have DONE something. Without this, "outline off:
    // 0 rebuilds" reads the same whether the toggle got cheaper or stopped
    // working, and the change that made it cheap is exactly the kind that
    // could have made it a no-op.
    const ink = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n += 1;
      }
      return n / (d.length / 4);
    };

    const out = [];
    const act = async (name, fn) => {
      window.__faceBuilds = 0;
      window.__stationFastPath = 0;
      const before = performance.now();
      await fn();
      await settle(4);
      out.push({name, builds: window.__faceBuilds,
                fast: window.__stationFastPath,
                ms: +(performance.now() - before).toFixed(1),
                ink: ink(),
                // 🔴 AND HOW MUCH OF A REBUILD WAS ACTUALLY REBUILT. makeResident
                // keeps the ribbon and the "holds still" part against a hash of
                // their own faces, so a side chain appearing should reuse both
                // and rebuild only part 2. A rebuild that re-does the ribbon
                // for a change that did not touch it is the expensive kind, and
                // the counter alone cannot tell the two apart.
                rb: Object.assign({}, window.__rebuild || {}),
                why: (G.stationDecline && G.stationDecline()) || null});
    };

    // what the page was actually in, so the restores below put it back rather
    // than to a number this file made up - the ribbon part is cached against a
    // hash that includes the build parameters, and outline WIDTH is one of them
    const was = {mode: r.outlineMode, width: r.relativeOutlineWidth};
    const V = r.viewerState;
    await act('rotate', async () => {
      const R = V.rotation;
      V.rotation = [[0.9, -0.1, 0.42], [0.1, 0.99, 0.02], [-0.42, 0.02, 0.91]];
      r.render('rotate'); await settle(2); V.rotation = R;
    });
    await act('zoom', async () => {
      const z = V.zoom; V.zoom = z * 1.4; r.render('zoom');
      await settle(2); V.zoom = z;
    });
    await act('select', async () => {
      r.residueSelection = new Set([4, 5, 6, 7, 8]);
      r.render('select');
    });
    await act('clear selection', async () => {
      r.residueSelection = new Set(); r.render('clearSel');
    });
    await act('hover', async () => {
      r.hoveredResidue = 12; r.render('hover');
      r.hoveredResidue = null; r.render('unhover');
    });
    await act('colour scheme', async () => {
      const k = r.colorMode; r.colorMode = 'chain';
      if (r.colorsNeedUpdate !== undefined) r.colorsNeedUpdate = true;
      r.render('colour'); await settle(2);
      r.colorMode = k;
      if (r.colorsNeedUpdate !== undefined) r.colorsNeedUpdate = true;
      r.render('colourBack');
    });
    await act('shade', async () => {
      const v = r.shadeStrength; r.shadeStrength = 0.8; r.render('shade');
      await settle(2); r.shadeStrength = v;
    });
    await act('outline on', async () => {
      r.outlineMode = 'on'; r.relativeOutlineWidth = 3; r.render('outlineOn');
    });
    await act('outline off', async () => {
      r.outlineMode = 'none'; r.relativeOutlineWidth = 0; r.render('outlineOff');
    });
    // THE REST OF THE LOOK, which is all meant to be a uniform or a texture.
    // Each is set, rendered, and put back, so the row after it starts where
    // this one did - see the note below about the ribbon part's hash.
    const uniforms = [
      ['fade', 'cartoonFade', 0.6], ['smooth', 'cartoonSmooth', true],
      ['highlight', 'cartoonHighlight', 1.6], ['pencil', 'cartoonPencil', 0.5],
      ['clip near', 'clipNear', -5], ['clip far', 'clipFar', 5],
    ];
    for (const [name, prop, v] of uniforms) {
      await act(name, async () => {
        const k = r[prop]; r[prop] = v; r.render(prop);
        await settle(2); r[prop] = k; r.render(prop + 'Back');
      });
    }
    await act('ortho', async () => {
      const k = V.ortho; V.ortho = (k === 1 ? 0 : 1); r.render('ortho');
      await settle(2); V.ortho = k; r.render('orthoBack');
    });

    // 🔴 BACK TO A SETTLED STATE BEFORE THE ROWS THAT BUILD. makeResident keeps
    // the ribbon part against a hash that includes the build PARAMETERS, so
    // leaving the outline off here means the next build's ribbon does not match
    // the cached one and is rebuilt - which reads as "showing a side chain
    // rebuilds the ribbon" when it is really "the row above changed the params".
    // The first version of this file did exactly that and the asymmetry it
    // produced (rebuilt on, reused off) was a property of the ORDER.
    r.outlineMode = was.mode; r.relativeOutlineWidth = was.width;
    r.render('outlineRestore'); await settle(4);
    r.render('outlineSettle'); await settle(4);

    await act('side chains on', async () => {
      const o = r.objectsData[r.currentObjectName];
      const cur = o.sidechains instanceof Set ? new Set(o.sidechains) : new Set();
      for (const i of [10, 11, 12, 13]) cur.add(i);
      o.sidechains = cur;
      r.reloadDrawn();
    });
    await act('side chains off', async () => {
      const o = r.objectsData[r.currentObjectName];
      o.sidechains = new Set();
      r.reloadDrawn();
    });
    // 🔴 DOES THE SIGNATURE SETTLE? A key computed from anything a BUILD
    // changes can fail to converge: the frame rebuilds, the rebuild moves the
    // term, and the next frame sees a mismatch it did not ask for and rebuilds
    // again, for ever. The outline term reads whether the resident mesh has
    // edges, which is exactly that shape, so it is checked rather than argued
    // about - three idle renders after the last real change, which must cost
    // nothing at all.
    await act('idle after changes', async () => {
      r.render('idle1'); await settle(2);
      r.render('idle2'); await settle(2);
      r.render('idle3');
    });
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
profile_dir = "/tmp/py2dmol-rebuildactions"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_rebuildactions.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
print(f"{FILE}: mesh rebuilds per action, station path on")
for row in out["out"]:
    print(f"  {row['name']:<18} builds {row['builds']}  fast {row['fast']}"
          f"  {row['ms']:>6.1f} ms")
    rb = row.get("rb") or {}
    if row["builds"]:
        print(f"       ribbon {'reused' if rb.get('ribbonReused') else 'REBUILT'}"
              f" ({rb.get('nRibbon')} faces),"
              f" other {'reused' if rb.get('otherReused') else 'REBUILT'}"
              f" ({rb.get('nOther')}), side {rb.get('nSide')} faces")
    if row["builds"] and row["why"]:
        print(f"       why: {row['why']}")
    if row["name"] in MUST_REUSE_RIBBON and row["builds"] \
            and not rb.get("ribbonReused"):
        bad.append(f"{row['name']} rebuilt the ribbon's {rb.get('nRibbon')}"
                   " faces, and it changes none of them - something that is not"
                   " the ribbon has got into ribbonHashOf")
    if row["name"] in MUST_COME_BACK and row["builds"]:
        bad.append(f"{row['name']} rebuilt the mesh {row['builds']} time(s)"
                   " - it returns to the picture from two steps ago, which the"
                   " spare mesh is holding. keepArrays is gated on something"
                   f" other than the size cap again. {row['why'] or ''}")
    if row["name"] in MUST_BE_FREE and row["builds"]:
        bad.append(f"{row['name']} rebuilt the mesh {row['builds']} time(s)"
                   f" - it changes no geometry, so it must not."
                   f" {row['why'] or 'no reason recorded'}")

# 🔴 AND THE OUTLINE TOGGLE HAS TO DO SOMETHING. It costs no rebuild now
# because the edges are already in the buffer and the draw pass simply stops
# issuing them - which is indistinguishable, from the rebuild counter alone,
# from a toggle that quietly went dead.
byName = {r["name"]: r for r in out["out"]}
on = byName.get("outline on"); off = byName.get("outline off")
if on and off:
    d = on["ink"] - off["ink"]
    print(f"\n  outline ink: {100 * on['ink']:.2f}% on against"
          f" {100 * off['ink']:.2f}% off  ({100 * d:+.2f} points)")
    if d <= 0.002:
        bad.append(f"turning the outline on inked {100 * on['ink']:.2f}% of the"
                   f" frame and turning it off {100 * off['ink']:.2f}% - the"
                   " toggle costs no rebuild because it is not doing anything")

print()
for b in bad:
    print("FAIL: " + b)
print("rebuild actions: " + ("FAILED" if bad else "nothing rebuilds that should not"))
sys.exit(1 if bad else 0)
