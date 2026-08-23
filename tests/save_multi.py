"""A Multi session comes back the way it was saved.

    python3 tests/save_multi.py

Three objects, one of them switched off, per-object state on two of them, and
a camera the user chose - saved through the Save button's own path, cleared,
and loaded back. What has to survive: the MODE (the button pressed, the list
open, the picker greyed), which eyes are on, which object is being edited,
every object's own state, and the view.

The view was the one that did not. Objects arrive one at a time and each
arrival rebuilds the merge of everything loaded so far, which frames on what
it finds - every object in a restored session is new to the renderer, so the
rule that widens the view for a newly loaded object fires for all of them. By
the time the shown set was applied, the centre and extent from the file were
long gone: 17.8 saved, 51.3 restored. The saved camera is re-applied last now.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_savemulti.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const eyes = () => Array.from(document.querySelectorAll('#objectList .object-list-eye'));
  const rows = () => Array.from(document.querySelectorAll('#objectList .object-list-row'));
  const rowState = () => Array.from(document.querySelectorAll('#objectList .object-list-row'))
    .map((x) => x.querySelector('.object-list-name').textContent
      + (x.classList.contains('is-hidden') ? '-' : '+'));
  const ink = (c) => { const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4)
      if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) n++; return n; };
  const st = (r, tag) => ({
    tag,
    drawn: r.drawnObjects(), editing: r.currentObjectName,
    shown: r.shownObjects instanceof Set ? Array.from(r.shownObjects).sort() : null,
    multiBtn: document.getElementById('objectListButton').getAttribute('aria-pressed'),
    listHidden: document.getElementById('objectList').hidden,
    rows: rowState(),
    pickerDisabled: document.getElementById('objectSelect').disabled,
    picker: document.getElementById('objectSelect').value,
    zoom: Math.round(r.viewerState.zoom * 1000) / 1000,
    extent: Math.round((r.viewerState.extent || 0) * 100) / 100,
    centre: r.viewerState.center ? [Math.round(r.viewerState.center.x * 10) / 10,
      Math.round(r.viewerState.center.y * 10) / 10] : null,
    rot0: r.viewerState.rotation[0].map((v) => Math.round(v * 100) / 100),
    per: Object.fromEntries(Object.keys(r.objectsData).map((k) => [k, {
      sc: r.objectsData[k].sidechains ? r.objectsData[k].sidechains.size : null,
      hb: r.objectsData[k].hiddenBackbone ? r.objectsData[k].hiddenBackbone.size : null,
      col: JSON.stringify(((r.objectsData[k].color || {}).value || {}).position || null),
    }])),
    n: r.coords.length, ink: ink(r.canvas),
  });
  const go = async () => {
    const R = {};
    try {
      await load('1UBQ.cif'); await wait(500);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      await load('3CHY.cif'); await wait(700);
      await load('6MRR.cif'); await wait(700);
      const names = Object.keys(r.objectsData);
      R.names = names;
      // MULTI, with the middle object switched off
      document.getElementById('objectListButton').click(); await wait(400);
      for (let k = 0; k < rows().length; k++) {
        const want = k !== 1;
        const on = !rows()[k].classList.contains('is-hidden');
        if (on !== want) { eyes()[k].click(); await wait(350); }
      }
      // ...some per-object state, and a camera the user chose
      r.objectsData[names[0]].sidechains = new Set([1, 2, 3]);
      r.objectsData[names[2]].hiddenBackbone = new Set([0, 1]);
      r.objectsData[names[0]].color = {type: 'advanced', value: {position: {2: '#ff0000'}}};
      r.reloadDrawn(); await wait(500);
      r.viewerState.zoom = 1.7;
      r.viewerState.rotation = [[0, 1, 0], [-1, 0, 0], [0, 0, 1]];
      r.render('probe camera'); await wait(300);
      R.before = st(r, 'before save');

      // SAVE through the button's own path
      const RealBlob = window.Blob;
      let captured = null;
      window.Blob = function (parts, opts) { captured = parts[0]; return new RealBlob(parts, opts); };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      window.saveViewerState();
      window.Blob = RealBlob;
      HTMLAnchorElement.prototype.click = realClick;
      R.saved = JSON.parse(captured).viewer_state.shown_objects;

      r.clearAllObjects(); await wait(300);
      R.cleared = st(r, 'cleared');
      await window.loadViewerState(JSON.parse(captured));
      await wait(1200);
      R.after = st(r, 'after load');
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
src=open(os.path.join(ROOT,"index.html")).read()
stamp=str(int(time.time()*1000))
src=re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")', lambda m: m.group(1)+"?v="+stamp+m.group(3), src)
open(PROBE,"w").write(src.replace("</body>", JS+"</body>"))
box=[]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(self,*a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length",0)))))
        self.send_response(200); self.send_header("Content-Length","2"); self.end_headers(); self.wfile.write(b"ok")
socketserver.ThreadingTCPServer.allow_reuse_address=True
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9707),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-savemulti","--no-first-run",
  "--window-size=1100,950","http://127.0.0.1:9707/_savemulti.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end=time.time()+200
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-savemulti",ignore_errors=True)
R=box[0] if box else {"error":"no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

b, a = R["before"], R["after"]
print(f"saved shown_objects: {R.get('saved')}")
for tag, s in (("before", b), ("after", a)):
    print(f"  {tag:6s} drawn={s['drawn']} editing={s['editing']} rows={s['rows']}")
    print(f"         multi={s['multiBtn']} listHidden={s['listHidden']}"
          f" pickerOff={s['pickerDisabled']} picker={s['picker']}")
    print(f"         zoom={s['zoom']} extent={s['extent']} centre={s['centre']}"
          f" n={s['n']} ink={s['ink']}")
print(f"  cleared: drawn={R['cleared']['drawn']} rows={R['cleared']['rows']}")

bad = []
if R["cleared"]["n"]:
    bad.append("Clear All left coordinates behind, so the load is not from scratch")
for field, what in [
    ("drawn", "the objects on screen"),
    ("shown", "the shown set"),
    ("editing", "which object is being edited"),
    ("rows", "the list rows and their eyes"),
    ("multiBtn", "the Multi button"),
    ("listHidden", "whether the list is open"),
    ("pickerDisabled", "whether the picker is greyed"),
    ("picker", "what the picker names"),
    ("per", "the per-object state"),
    ("n", "the size of the coordinate array"),
]:
    if b[field] != a[field]:
        bad.append(f"{what} came back different: {b[field]} -> {a[field]}")
# ...THE VIEW, which is the one that did not survive
for field in ("zoom", "extent", "centre", "rot0"):
    if b[field] != a[field]:
        bad.append(f"the view's {field} came back {a[field]}, not {b[field]}")
# ...and the picture itself, within the noise of the paper grain
if not b["ink"] or abs(a["ink"] - b["ink"]) > 0.01 * b["ink"]:
    bad.append(f"the restored picture inks {a['ink']} against {b['ink']}")
for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
