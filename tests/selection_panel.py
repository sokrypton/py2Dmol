"""The selection panel's Show / Hide pairs, driven as a user drives them.

    python3 tests/selection_panel.py

Each part of a residue - its side chains, its backbone - is answered by two
buttons rather than one switch: the action is explicit, and the button matching
what is DRAWN is filled, so the control says both what it will do and what it
has done. A selection that disagrees with itself fills neither, which is the
state a single switch could only show as a grey smear. Contacts read Add /
Remove, because a contact does not exist until you make one.

The node tests score this against a stub DOM. This presses the real buttons
and looks at the real structure and the real canvas.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_selpanel.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const on = (id) => {
    const b = document.getElementById(id);
    return b ? b.classList.contains('is-on') : null;
  };
  const press = async (id) => {
    document.getElementById(id).click();
    await wait(500);
  };
  const select = async (r, list) => {
    r.residueSelection = new Set(list);
    document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
    await wait(400);
  };
  const st = (r, tag) => ({
    tag,
    scShow: on('sidechainShowButton'), scHide: on('sidechainHideButton'),
    mcShow: on('mainchainShowButton'), mcHide: on('mainchainHideButton'),
    // ONE CONTROL PER STATE: Add until there is a contact, then its own
    // colour, width and a bin - and no Add.
    addShown: !document.getElementById('contactAddButton').hidden,
    binShown: !document.getElementById('contactDeleteButton').hidden,
    sliderShown: !document.getElementById('contactWidthSlider').hidden,
    contactRow: !document.getElementById('contactRow').hidden,
    panel: !document.getElementById('selectionPanel').hidden,
    atoms: r.sidechainMap ? r.sidechainMap.size : 0,
    hiddenBB: r.backboneHiddenSet() ? r.backboneHiddenSet().size : 0,
    contacts: (r.objectsData[r.currentObjectName].contacts || []).length,
    n: r.coords.length,
  });
  const rowFit = (id) => {
    const row = document.getElementById(id);
    if (!row || row.hidden) return null;
    const kids = Array.from(row.children).filter((k) => !k.hidden
      && k.getBoundingClientRect().width > 0);
    const h = row.getBoundingClientRect().height;
    const tall = Math.max(...kids.map((k) => k.getBoundingClientRect().height));
    return {wrapped: h > tall * 1.5, height: Math.round(h),
      tallest: Math.round(tall), overflow: row.scrollWidth - row.clientWidth,
      controls: kids.length,
      widths: kids.map((k) => (k.id || (k.querySelector && k.querySelector('input')
        && k.querySelector('input').id) || k.className.split(' ')[0] || k.tagName)
        + ':' + Math.round(k.getBoundingClientRect().width)),
      rowWidth: Math.round(row.getBoundingClientRect().width)};
  };

  const go = async () => {
    const R = {steps: []};
    try {
      await load('1UBQ.cif'); await wait(700);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      R.steps.push(st(r, 'no selection'));

      await select(r, [10, 11, 12, 13]);
      R.steps.push(st(r, 'selected'));

      await press('sidechainShowButton');
      R.steps.push(st(r, 'sc show'));
      // the ordinary case, with Elements on the row beside the pair
      R.fitProtein = {sidechain: rowFit('sidechainRow'), mainchain: rowFit('mainchainRow')};
      await press('sidechainHideButton');
      R.steps.push(st(r, 'sc hide'));

      await press('mainchainHideButton');
      R.steps.push(st(r, 'mc hide'));
      await press('mainchainShowButton');
      R.steps.push(st(r, 'mc show'));

      // A SELECTION THAT DISAGREES WITH ITSELF fills neither button.
      await select(r, [10, 11]);
      await press('sidechainShowButton');
      await select(r, [10, 11, 20, 21]);
      R.steps.push(st(r, 'mixed'));
      await select(r, [10, 11]);
      await press('sidechainHideButton');

      // CONTACTS: Add and Remove, on a pair
      await select(r, [10, 40]);
      R.steps.push(st(r, 'two picked'));
      await press('contactAddButton');
      R.steps.push(st(r, 'added'));
      // ...AND THE BIN IS A BIN. An icon button whose glyph does not load is
      // an empty square that deletes things.
      {
        const bin = document.getElementById('contactDeleteButton');
        const i = bin.querySelector('i');
        const box = bin.getBoundingClientRect();
        const glyph = i ? getComputedStyle(i, '::before') : null;
        R.bin = {
          width: Math.round(box.width), height: Math.round(box.height),
          font: glyph ? glyph.fontFamily : null,
          content: glyph ? glyph.content : null,
        };
      }
      await press('contactDeleteButton');
      R.steps.push(st(r, 'removed'));
      // THE SSE CONTROL SAYS THE SAME THING EVERY TIME. It read the
      // assignment off a render-time cache and gave up when it was absent - so
      // it said "Helix (DSSP)" after one click and "DSSP" after the next, with
      // nothing about the structure having changed. Adding a contact was
      // enough to flip it, because that drops the cache.
      R.sse = [];
      const sseFace = () => {
        const sel = document.getElementById('selSsSelect');
        const opt = sel.options[sel.selectedIndex];
        return {value: sel.value, text: opt ? opt.textContent : null,
                hidden: sel.hidden};
      };
      await select(r, [10, 11, 12]);
      R.sse.push(['picked', sseFace()]);
      await select(r, [20, 21]);
      R.sse.push(['picked again', sseFace()]);
      await select(r, [10, 11, 12]);
      R.sse.push(['back', sseFace()]);
      // ...the things that drop the cache
      await press('sidechainShowButton');
      R.sse.push(['after side chains', sseFace()]);
      await select(r, [10, 40]);
      await press('contactAddButton');
      await select(r, [10, 11, 12]);
      R.sse.push(['after a contact', sseFace()]);
      await select(r, [10, 40]);
      await press('contactDeleteButton');
      await select(r, [10, 11, 12]);
      R.sse.push(['after removing it', sseFace()]);
      // ...AND IN EVERY STYLE. The assignment caches are filled by the CPU
      // cartoon pass; the tube style never runs it and the GPU cartoon path
      // builds its own mesh instead, so a panel that reads those caches has
      // nothing to read there - the control said "DSSP" with no structure
      // named, in a viewer that knew perfectly well what the structure was.
      r.setStyle('tube'); await wait(600);
      await select(r, [10, 11, 12]);
      R.sse.push(['tube', sseFace()]);
      r.setStyle('cartoon'); r.useGPU = true; await wait(700);
      await select(r, [20, 21]);
      await select(r, [10, 11, 12]);
      R.sse.push(['gpu cartoon', sseFace()]);
      r.useGPU = false; await wait(500);
      await select(r, [10, 11, 12]);

      // ...and a forced state reads as the bare word
      const sel = document.getElementById('selSsSelect');
      sel.value = 'H'; sel.dispatchEvent(new Event('change', {bubbles: true}));
      await wait(500);
      R.sse.push(['forced helix', sseFace()]);
      sel.value = 'dssp'; sel.dispatchEvent(new Event('change', {bubbles: true}));
      await wait(500);
      R.sse.push(['back to auto', sseFace()]);
      await press('sidechainHideButton');

      // THE ROW STILL FITS. A pair is wider than the switch it replaced, and
      // the side-chain row carries a swatch, the pair, Plate and Elements in a
      // 340px panel - a row that wraps to a second line is the confusion this
      // was meant to remove.
      await load('1YNE.cif'); await wait(900);
      await select(r, [2, 3, 4]);
      await press('sidechainShowButton');
      await wait(400);   // ...atoms exist now, so Elements joins the row too
      // (defined above its second use so the protein row can be measured too)
      R.fit = {sidechain: rowFit('sidechainRow'), mainchain: rowFit('mainchainRow'),
               contact: rowFit('contactRow'),
               panelWidth: document.getElementById('selectionPanel').clientWidth};
      await select(r, [2, 3]);
      await press('sidechainHideButton');

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
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9711),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-selpanel","--no-first-run",
  "--window-size=1100,950","http://127.0.0.1:9711/_selpanel.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end=time.time()+180
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-selpanel",ignore_errors=True)
R=box[0] if box else {"error":"no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

for s in R["steps"]:
    print(f"  {s['tag']:12s} sc=[{s['scShow']!s:5} {s['scHide']!s:5}]"
          f" mc=[{s['mcShow']!s:5} {s['mcHide']!s:5}]"
          f" contact=[add {s['addShown']!s:5} bin {s['binShown']!s:5}"
          f" slider {s['sliderShown']!s:5}] row={s['contactRow']!s:5}"
          f" atoms={s['atoms']:<4} hiddenBB={s['hiddenBB']:<3} contacts={s['contacts']}")
step = {s['tag']: s for s in R["steps"]}
bad = []
def want(tag, field, value, why):
    got = step[tag][field]
    if got != value:
        bad.append(f"{tag}: {field} is {got}, expected {value} - {why}")

# the pair says what is DRAWN
want('sc show', 'scShow', True, 'Show is filled once the side chains are drawn')
want('sc show', 'scHide', False, 'Hide is not filled at the same time')
if not step['sc show']['atoms']:
    bad.append('pressing Show drew no side-chain atoms')
want('sc hide', 'scHide', True, 'Hide is filled once they are gone')
want('sc hide', 'scShow', False, 'Show is not filled at the same time')
if step['sc hide']['atoms']:
    bad.append(f"pressing Hide left {step['sc hide']['atoms']} atoms behind")

want('mc hide', 'mcHide', True, 'Hide is filled once the backbone is hidden')
if not step['mc hide']['hiddenBB']:
    bad.append('pressing Hide on the main chain hid nothing')
want('mc show', 'mcShow', True, 'Show is filled once it is back')
if step['mc show']['hiddenBB']:
    bad.append('pressing Show left the backbone hidden')

# ...and NEITHER when the selection disagrees with itself
want('mixed', 'scShow', False, 'a mixed selection does not read as all shown')
want('mixed', 'scHide', False, 'a mixed selection does not read as all hidden')

# contacts: Add / Remove
want('two picked', 'contactRow', True, 'the contact row appears for exactly two')
want('two picked', 'addShown', True, 'Add is the only thing on the row yet')
want('two picked', 'binShown', False, 'there is nothing to delete yet')
want('two picked', 'sliderShown', False, 'and nothing to size')
want('added', 'addShown', False, 'Add is gone once the contact exists')
want('added', 'binShown', True, 'the bin takes its place, after the slider')
want('added', 'sliderShown', True, 'and the contact has a width to set')
if step['added']['contacts'] != 1:
    bad.append(f"Add made {step['added']['contacts']} contacts")
want('removed', 'addShown', True, 'Add is back once the contact is gone')
want('removed', 'binShown', False, 'and the bin is not')
if step['removed']['contacts']:
    bad.append(f"the bin left {step['removed']['contacts']} contacts")
want('no selection', 'panel', False, 'the panel is away without a selection')
want('selected', 'panel', True, 'the panel appears with one')
print("  the SSE control:")
for tag, face in (R.get("sse") or []):
    print(f"    {tag:20s} {face['value']!r} reading {face['text']!r}")
sse = dict((t, f) for t, f in (R.get("sse") or []))
# THE SAME SELECTION, over and over, through the things that used to flip it.
# 'picked again' is a DIFFERENT selection - reading differently there is the
# control working, not wobbling.
same = ['picked', 'back', 'after side chains', 'after a contact',
        'after removing it', 'tube', 'gpu cartoon', 'back to auto']
faces = {sse[t]['text'] for t in same if t in sse}
if len(faces) != 1:
    bad.append(f"the same selection read {faces} across actions that changed"
               " nothing about its structure")
if not any(f and '(DSSP)' in f for f in faces):
    bad.append(f"the unforced state never names the assignment: {faces}")
# ...and a different selection is allowed to differ, or the control is stuck
if sse.get('picked again', {}).get('text') == sse.get('picked', {}).get('text'):
    bad.append("two selections with different structures read the same - the"
               " control is showing something other than their structure")
if sse.get('forced helix', {}).get('text') != 'Helix':
    bad.append(f"a forced helix reads {sse.get('forced helix', {}).get('text')!r},"
               " not the bare word")
if sse.get('back to auto', {}).get('value') != 'dssp':
    bad.append("going back to DSSP did not stick")

bin = R.get("bin") or {}
print(f"  the bin: {bin.get('width')}x{bin.get('height')}px,"
      f" glyph {bin.get('content')} in {bin.get('font')}")
if not bin.get("width") or bin["width"] < 20 or bin["height"] < 20:
    bad.append(f"the bin button is {bin.get('width')}x{bin.get('height')}px")
if not bin.get("content") or bin["content"] in ('none', 'normal', '""'):
    bad.append("the bin has no glyph - an icon button with no icon is an empty"
               " square that deletes things")

fitP = R.get("fitProtein") or {}
print("  protein rows: " + ", ".join(f"{k}={v}" for k, v in fitP.items()))
for row, f in fitP.items():
    if f and f['wrapped']:
        bad.append(f"the protein {row} row wraps: {f['height']}px tall for"
                   f" controls of {f['tallest']}px - {f['widths']}")

fit = R.get("fit") or {}
print(f"  rows in a {fit.get('panelWidth')}px panel: "
      + ", ".join(f"{k}={v}" for k, v in fit.items() if k != 'panelWidth'))
for row in ('sidechain', 'mainchain', 'contact'):
    f = fit.get(row)
    if not f:
        continue
    if f['wrapped']:
        bad.append(f"the {row} row wraps: {f['height']}px tall for controls of"
                   f" {f['tallest']}px, with {f['controls']} on it - {f['widths']}")
    if f['overflow'] > 1:
        bad.append(f"the {row} row overflows its panel by {f['overflow']}px")

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
