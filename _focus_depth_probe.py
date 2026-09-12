"""HANDOFF PROBE: the focus-exit depth range. Not a gate - an instrument.

    python3 _focus_depth_probe.py            # animated exit (the reported path)
    python3 _focus_depth_probe.py noanim     # r.exitFocusMode(false) instead

Loads 1YNE (a 20-model NMR ensemble), focuses one residue, leaves focus and
presses Orient - printing after every step where the ink actually is, plus the
camera and the GPU's draw-time numbers.

🔴 IT IS THE ONLY CHECK ON THE FOCUS-EXIT DEPTH RANGE. The fix for that lives
in stationMeshOf's centre handling; nothing in tests/ gates it. Keep SSE used to
be an arm here - toggling it off was what appeared to cure the bug - and that
mode has been removed.

READ THE `offset` COLUMN: it is the centroid of the dark pixels as an offset
from the middle of the canvas. "It does not recenter" is a statement about that
number and nothing else.

`window.__zTrace = 1` in src/cartoon/paintgl.js was used to log every write to
resident.zMin/zMax; that instrumentation has been removed from the tree. See
the handoff notes for what it printed.
"""
import http.server, json, os, socketserver, sys, threading, time
sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol/tests')
from cdp import launch, evaluate, wait_for
from probe_js import HELPERS
ROOT='/Users/mini/Documents/GitHub/py2Dmol'
JS = """(async (keep) => {
 try {
  const t = await (await fetch('/1YNE.cif')).text();
  await window.processFiles([{name:'1YNE.cif', readAsync:()=>Promise.resolve(t)}], true);
  await until(loaded, 300000); await settle(14);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const cv = document.querySelector('#canvas');
  // WHERE THE INK IS, as an offset from the middle of the canvas. "It does not
  // recenter" is a statement about this number and nothing else.
  const where = () => {
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0);
    const im = c.getContext('2d').getImageData(0,0,c.width,c.height), d = im.data;
    let n=0, sx=0, sy=0;
    for (let y=0;y<im.height;y++) for (let x=0;x<im.width;x++) {
      const i=(y*im.width+x)*4;
      if ((d[i]*299+d[i+1]*587+d[i+2]*114)/1000 < 215) { n++; sx+=x; sy+=y; }
    }
    if (!n) return {ink: 0, dx: null, dy: null};
    return {ink: n, dx: Math.round(sx/n - im.width/2),
            dy: Math.round(sy/n - im.height/2)};
  };
  window.__zTrace = 1; window.__zLog = [];
  const steps = [];
  const note = (tag) => steps.push(Object.assign({tag,
      slab: r.clipSlabOn && r.clipSlabOn() ? 'ON' : 'off',
      near: r._clipNear !== undefined ? +Number(r._clipNear).toFixed(1) : null,
      far: r._clipFar !== undefined ? +Number(r._clipFar).toFixed(1) : null,
      centre: r.viewerState && r.viewerState.center
          ? [Math.round(r.viewerState.center.x), Math.round(r.viewerState.center.y),
             Math.round(r.viewerState.center.z)] : null,
      zoomS: r.viewerState ? +Number(r.viewerState.zoom).toFixed(3) : null,
      extent: r.viewerState && r.viewerState.extent != null
          ? +Number(r.viewerState.extent).toFixed(2) : null,
      aspect: r.viewerState && r.viewerState.extentAspect
          ? [+r.viewerState.extentAspect.x.toFixed(2), +r.viewerState.extentAspect.y.toFixed(2)] : null,
      gpu: (() => { const G = window.py2dmolCartoonGPU;
          if (!G || !G.stationDump) return null;
          const d = G.stationDump();
          return d ? {drawScale: +Number(d.drawScale).toFixed(3),
                      scaleMul: +Number(d.scaleMul).toFixed(4),
                      buildScale: +Number(d.buildScale).toFixed(3),
                      zMin: +Number(d.zMin).toFixed(1), zMax: +Number(d.zMax).toFixed(1),
                      count: d.residentCount,
                      stations: d.stations, pieces: d.pieces,
                      centroids: d.centroidLen,
                      stick: (() => { const sr = G.stickRefresh && G.stickRefresh();
                        return sr ? {rad: sr.rad, rows: sr.rows, why: (sr.why||'').slice(0,40)}
                                  : null; })()} : null; })(),
      rot: r.viewerState && r.viewerState.rotation
          ? r.viewerState.rotation.map((row) => row.map((v) => +Number(v).toFixed(2))).flat().join(',')
          : null,
      zoom: +(r.zoomLevel || (window.py2dmolCartoonGPU && window.py2dmolCartoonGPU.currentZoom
              ? window.py2dmolCartoonGPU.currentZoom() : 0)).toFixed(3),
      focus: !!r._focusMode,
      coords: r.coords.length}, where()));
  note('loaded');
  // focus on a position, the way the button does
  if (window.__plain) {
    // NO FOCUS AT ALL: just materialise side chains and take them away again.
    r.showSidechains({positions: [Math.floor(r.coords.length/3)]});
    await settle(20); note('sidechains shown');
    r.hideSidechains({positions: [Math.floor(r.coords.length/3)]});
    await settle(20); note('sidechains hidden');
  } else {
    r.setResidueSelection([Math.floor(r.coords.length/3)]);
    await settle(4);
    document.querySelector('#focusButton').click();
    await settle(26);
    note('focused');
    if (window.__noAnim) { r.exitFocusMode(false); await settle(26); note('unfocused (no flight)'); }
    else { document.querySelector('#focusButton').click(); await settle(26); note('unfocused'); }
  }
  r.clearResidueSelection(); await settle(6);
  // 🔴 THE SPAN, NOT THE LABEL. index.html draws Orient as a fake toggle and
  // main.js listens on the inner <span>; clicking the label does nothing at
  // all, which reads exactly like "orient does not recentre".
  const os = document.querySelector('#orientToggle span');
  if (!os) return JSON.stringify({error: 'no orient span'});
  os.click();
  await settle(30);
  note('oriented');
  // ...and the one experiment that separates camera from cached geometry:
  // throw the resident mesh away and draw the same camera again.
  if (window.py2dmolCartoonGPU && window.py2dmolCartoonGPU.invalidate) {
    window.py2dmolCartoonGPU.invalidate();
    r.render('probe-invalidate');
    await settle(14);
    note('after invalidate');
  }
  return JSON.stringify({steps, zlog: window.__zLog.slice(-14)});
 } catch (e) { return JSON.stringify({error: String((e&&e.stack)||e)}); }
})"""
probe = os.path.join(ROOT, '_yne.html')
open(probe,'w').write(open(os.path.join(ROOT,'dev.html')).read().replace(
  '</body>', "<script>window.__ready=false;window.addEventListener('load',()=>{"+HELPERS+"window.__go="+JS+";window.__ready=true;});</script></body>"))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(self,*a): pass
socketserver.TCPServer.allow_reuse_address=True
h=socketserver.TCPServer(("127.0.0.1",9703),H); threading.Thread(target=h.serve_forever,daemon=True).start()
NOANIM = (len(sys.argv) > 1 and sys.argv[1] == 'noanim')
c,ws=launch(9266,"/tmp/py2dmol-yne")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    for keep in ("false",):
        ws.call("Page.navigate", url="about:blank"); time.sleep(0.4)
        ws.call("Page.navigate", url="http://127.0.0.1:9703/_yne.html")
        wait_for(ws,"window.__ready === true",timeout=120,what="page")
        evaluate(ws, "window.__noAnim = " + ("true" if NOANIM else "false"))
        RR=json.loads(evaluate(ws,f"window.__go({keep})"))
        R=RR['steps'] if isinstance(RR, dict) and 'steps' in RR else RR
        for z in (RR.get('zlog') or []): print("   zlog:", z)
        if isinstance(R, dict) and R.get('error'):
            print(f"keep={keep}: {R['error'][:200]}"); continue
        print(f"--- Keep SSE {'ON' if keep=='true' else 'OFF (control)'} ---")
        for s in R:
            print(f"   {s['tag']:<14} ink {s['ink']:>6} offset ({s['dx']:>4},{s['dy']:>4})"
                  f"  slab={s['slab']:<3} extent={s['extent']} aspect={s['aspect']}"
                  f" coords={s['coords']} centre={s['centre']}")
            print(f"                  gpu={s['gpu']}")
finally:
    c.kill(); h.shutdown(); os.remove(probe)
