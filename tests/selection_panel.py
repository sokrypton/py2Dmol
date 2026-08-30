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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
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
  const on = (id) => {
    const b = document.getElementById(id);
    return b ? b.classList.contains('is-on') : null;
  };
  //HELPERS
  const press = async (id) => {
    document.getElementById(id).click();
    await settle();
  };
  const select = async (r, list) => {
    r.residueSelection = new Set(list);
    document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
    await settle();
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
      await load('1UBQ.cif'); await until(loaded); await settle();
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
        // ...AND IT HAS TO FIT. The face is what the row can spare - 84px -
        // and a word that runs past it is clipped to something like "Helix (D".
        const probe = document.createElement('span');
        const cs = getComputedStyle(sel);
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;`
          + `font:${cs.font}`;
        probe.textContent = opt ? opt.textContent : '';
        document.body.appendChild(probe);
        const textW = probe.getBoundingClientRect().width;
        probe.remove();
        return {value: sel.value, text: opt ? opt.textContent : null,
                hidden: sel.hidden,
                // the arrow and the padding the select puts round its text
                fits: textW + 34 <= sel.getBoundingClientRect().width + 0.5,
                textW: Math.round(textW),
                boxW: Math.round(sel.getBoundingClientRect().width)};
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
      // THE TUBE DRAWS NO SECONDARY STRUCTURE, so the control is not there -
      // unless the SS colour mode is on, which paints it in any style.
      r.setStyle('tube'); await settle();
      await select(r, [10, 11, 12]);
      R.tubeHidden = document.getElementById('selSsSelect').hidden;
      const colorSel = document.getElementById('colorSelect');
      if (colorSel) {
        colorSel.value = 'ss';
        colorSel.dispatchEvent(new Event('change', {bubbles: true}));
      }
      await settle();
      await select(r, [10, 11, 12]);
      R.tubeSsColour = document.getElementById('selSsSelect').hidden;
      R.sse.push(['tube', sseFace()]);
      if (colorSel) {
        colorSel.value = 'auto';
        colorSel.dispatchEvent(new Event('change', {bubbles: true}));
      }
      await settle();
      r.setStyle('cartoon'); r.useGPU = true; await settle();
      await select(r, [20, 21]);
      await select(r, [10, 11, 12]);
      R.sse.push(['gpu cartoon', sseFace()]);
      r.useGPU = false; await settle();
      await select(r, [10, 11, 12]);

      // ...and a forced state reads as the bare word
      const sel = document.getElementById('selSsSelect');
      sel.value = 'H'; sel.dispatchEvent(new Event('change', {bubbles: true}));
      await settle();
      R.sse.push(['forced helix', sseFace()]);
      sel.value = 'dssp'; sel.dispatchEvent(new Event('change', {bubbles: true}));
      await settle();
      R.sse.push(['back to auto', sseFace()]);
      await press('sidechainHideButton');

      // ---- THE COLOUR PICKER OFFERS MODES, NOT ONLY COLOURS ----------------
      //
      // resolveColorHierarchy's applySpec has read a mode name at position
      // level since it was written, and obj.sidechainColor takes one too -
      // and nothing in any interface could SAY one. The point of it is the
      // combination: the backbone answering one question and a pocket's side
      // chains answering another, on one picture.
      {
        const shot = () => {
          const c = document.querySelector('#canvasContainer canvas');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let h = 0;
          for (let i = 0; i < d.length; i += 4) {
            h = (h * 31 + d[i] * 7 + d[i + 1] * 13 + d[i + 2] * 17) >>> 0;
          }
          return h;
        };
        const menuSelect = async (btnId, menuId) => {
          document.getElementById(btnId).click();     // builds, then opens
          await settle();
          return document.getElementById(menuId)
            .querySelector('.selection-color-mode');
        };
        const pick = async (btnId, menuId, value) => {
          const sel = await menuSelect(btnId, menuId);
          if (!sel) return false;
          sel.value = value;
          sel.dispatchEvent(new Event('change', {bubbles: true}));
          await settle();
          return true;
        };
        const obj = () => r.objectsData[r.currentObjectName];
        const posEntry = (i) => {
          const c = obj().color;
          return (c && c.type === 'advanced' && c.value.position)
            ? c.value.position[i] : undefined;
        };
        R.pick = {};
        await select(r, [10, 11, 12, 13]);

        const sel0 = await menuSelect('selColorButton', 'selColorMenu');
        R.pick.hasModeSelect = !!sel0;
        R.pick.options = sel0 ? [...sel0.options].map((o) => o.value) : [];
        // ...and the one it shows for a selection with no mode set
        R.pick.emptyValue = sel0 ? sel0.value : null;

        const before = shot();
        await pick('selColorButton', 'selColorMenu', 'hydrophobicity');
        R.pick.stored = posEntry(10);
        R.pick.drew = shot() !== before;
        // REOPENING SHOWS WHAT IS SET. A control that does not read back is
        // how the panel comes to disagree with the picture it is driving.
        const sel1 = await menuSelect('selColorButton', 'selColorMenu');
        R.pick.readsBack = sel1 ? sel1.value : null;
        // ...AND AUTO IS THE WAY OUT, which is a CLEAR rather than the 'auto'
        // mode: the position ends up with no opinion at all.
        await pick('selColorButton', 'selColorMenu', '');
        R.pick.cleared = posEntry(10) === undefined;
        R.pick.backToStart = shot() === before;

        // ...AND SSE IS ONE SCHEME HERE, NOT TWO. The Style dropdown carries
        // ss:pymol and ss:jmol; the palette is the VIEWER'S, so the picker
        // offers the scheme alone - and it has to be the bare `ss` that
        // applySpec recognises, or it is filed as a literal and draws grey.
        const beforeSs = shot();
        await pick('selColorButton', 'selColorMenu', 'ss');
        R.pick.ssStored = posEntry(10);
        R.pick.ssDrew = shot() !== beforeSs;
        await pick('selColorButton', 'selColorMenu', '');

        // THE WHOLE POINT: two questions at once. The backbone by chain, the
        // side chains of the same residues by hydropathy.
        await press('sidechainShowButton');
        await pick('selColorButton', 'selColorMenu', 'chain');
        await pick('scColorButton', 'scColorMenu', 'hydrophobicity');
        R.pick.bothStored = [posEntry(10),
          (obj().sidechainColor || {})[10]];
        // ...and they really are different colours on the canvas. The side
        // chain is asked through the atom the renderer appended for it, which
        // is the only index _sidechainColorOf answers for.
        const scAtom = (() => {
          if (!r.sidechainMap) return -1;
          for (const [atom, e] of r.sidechainMap) if (e.owner === 10) return atom;
          return -1;
        })();
        const asHex = (c) => c ? '#' + [c.r, c.g, c.b]
          .map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : null;
        R.pick.backboneColour = asHex(r.getAtomColor(10));
        R.pick.sidechainColour = scAtom >= 0 ? asHex(r.getAtomColor(scAtom)) : null;
        // ...the side-chain swatch resolves the mode rather than falling back
        // ...and it must show the SIDE CHAIN'S colour, not the residue's. A
        // swatch that falls back to the main chain is never blank, so "it has
        // a colour" passes against a mode that is not being resolved at all.
        const swatch = document.getElementById('scColorSwatch');
        const raw = swatch ? getComputedStyle(swatch).backgroundColor : '';
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(raw);
        R.pick.scSwatch = m ? '#' + m.slice(1, 4)
            .map((v) => Number(v).toString(16).padStart(2, '0')).join('') : null;
        await press('sidechainHideButton');
        await pick('selColorButton', 'selColorMenu', '');
        await pick('scColorButton', 'scColorMenu', '');

        // A CONTACT HAS NO SCHEME. It is one line between two residues, and
        // "rainbow" says nothing about what colour it should be - so that
        // picker keeps the Auto BUTTON it always had.
        await select(r, [10, 40]);
        await press('contactAddButton');
        document.getElementById('contactColorButton').click();
        await settle();
        const cm = document.getElementById('contactColorMenu');
        R.pick.contactHasModes = !!cm.querySelector('.selection-color-mode');
        R.pick.contactHasAuto = !!cm.querySelector('.selection-color-auto');
        document.getElementById('contactColorButton').click();
        await select(r, [10, 40]);
        await press('contactDeleteButton');
      }

      // THE ROW STILL FITS. A pair is wider than the switch it replaced, and
      // the side-chain row carries a swatch, the pair, Plate and Elements in a
      // 340px panel - a row that wraps to a second line is the confusion this
      // was meant to remove.
      // A NUCLEIC STRUCTURE, and the smallest one that is: the row is being
      // MEASURED, not the molecule, and 1YNE's 19,700 atoms cost eight seconds
      // of the probe to draw a panel that 355D's 660 lay out identically.
      await load('355D.cif'); await until(loaded); await settle();
      await select(r, [2, 3, 4]);
      await press('sidechainShowButton');
      await settle();   // ...atoms exist now, so Elements joins the row too
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
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
src=open(os.path.join(ROOT,"dev.html")).read()
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
end = time.time() + DEADLINE
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
print(f"  the SSE control in tube: hidden={R.get('tubeHidden')},"
      f" and with SS colours: hidden={R.get('tubeSsColour')}")
if not R.get('tubeHidden'):
    bad.append("the SSE control is offered in the tube style, which draws no"
               " secondary structure - four states of something invisible")
if R.get('tubeSsColour'):
    bad.append("the SSE control is withheld in the tube style even with SS"
               " colours on, where the letters are exactly what is painted")
print("  the SSE control:")
for tag, face in (R.get("sse") or []):
    print(f"    {tag:20s} {face['value']!r} reading {face['text']!r}"
          f" ({face['textW']}px of {face['boxW']}px)")
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
# ...and it names the STRUCTURE, not where the answer came from. "DSSP" is
# what the control used to read: the source, on a control whose other options
# are the answer itself.
if faces & {'DSSP', ''} or not faces:
    bad.append(f"the control reads {faces} rather than the structure - in the"
               " tube style that used to be all it could say")
# ...and a different selection is allowed to differ, or the control is stuck
if sse.get('picked again', {}).get('text') == sse.get('picked', {}).get('text'):
    bad.append("two selections with different structures read the same - the"
               " control is showing something other than their structure")
# ...AND EVERY FACE FITS THE BOX. "Helix (DSSP)" did not - the select is capped
# so the row does not wrap, and the text was clipped.
for tag, face in (R.get("sse") or []):
    if not face['fits']:
        bad.append(f"the SSE control reads {face['text']!r} at {face['textW']}px"
                   f" in a {face['boxW']}px box - it is clipped")
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

# ---- THE COLOUR PICKER OFFERS SCHEMES, NOT ONLY COLOURS --------------------
pick = R.get("pick") or {}
print(f"  picker: options={pick.get('options')}")
print(f"  picker: backbone {pick.get('backboneColour')} +"
      f" side chains {pick.get('sidechainColour')} from {pick.get('bothStored')}")
if not pick.get("hasModeSelect"):
    bad.append("the colour menu has no mode list - resolveColorHierarchy has"
               " taken a mode name at position level since it was written, and"
               " nothing in any interface could say one")
opts = pick.get("options") or []
for want in ("rainbow", "chain", "hydrophobicity", "plddt"):
    if want not in opts:
        bad.append(f"the colour menu does not offer {want}: {opts}")
if "auto" in opts:
    bad.append("the mode list offers 'auto' beside its own Auto entry - two"
               " things called Auto in one menu doing different things: the"
               " mode resolves the global scheme AT this position, the entry"
               " clears the override so nothing is said here at all")
for hidden in ("object", "entropy"):
    if hidden in opts:
        bad.append(f"{hidden} is offered here while the Style panel hides it -"
                   " the picker reads that list precisely so it inherits the"
                   " hidden-until-useful decision rather than keeping its own")
if [o for o in opts if ":" in o]:
    bad.append(f"the picker offers a composite value {opts} - ss:pymol is the"
               " mode AND the viewer-wide palette in one string, and stored at"
               " a position it is not a mode name at all: applySpec files it as"
               " a literal and the residues draw grey")
if opts.count("ss") > 1:
    bad.append("SSE is offered more than once - the two entries differ only in"
               " a palette that belongs to the whole viewer")
if pick.get("ssStored") != "ss":
    bad.append(f"picking SSE stored {pick.get('ssStored')!r}")
if not pick.get("ssDrew"):
    bad.append("picking SSE for a selection changed no pixels")
if pick.get("emptyValue") != "":
    bad.append(f"a selection with no scheme set reads {pick.get('emptyValue')!r}")
if pick.get("stored") != "hydrophobicity":
    bad.append(f"picking a scheme stored {pick.get('stored')!r} at the position")
if not pick.get("drew"):
    bad.append("picking a colour scheme for a selection changed no pixels")
if pick.get("readsBack") != "hydrophobicity":
    bad.append(f"reopening the menu reads {pick.get('readsBack')!r} rather than"
               " the scheme that is set - a control showing something the"
               " viewer is not doing is worse than no control")
if not pick.get("cleared"):
    bad.append("Auto did not clear the override")
if not pick.get("backToStart"):
    bad.append("Auto cleared the entry and left the picture changed")
both = pick.get("bothStored") or []
if both != ["chain", "hydrophobicity"]:
    bad.append("the backbone and its own side chains cannot hold two different"
               f" schemes at once: stored {both}")
if pick.get("backboneColour") == pick.get("sidechainColour"):
    bad.append("the backbone is on chain and its side chains on hydropathy and"
               f" both drew {pick.get('backboneColour')} - two schemes were set"
               " and one answer came out")
print(f"  picker: side-chain swatch {pick.get('scSwatch')}")
if pick.get("scSwatch") != pick.get("sidechainColour"):
    bad.append(f"the side-chain swatch shows {pick.get('scSwatch')} while the"
               f" side chain is drawn {pick.get('sidechainColour')}"
               f" (the residue is {pick.get('backboneColour')}) - the swatch is"
               " meant to show what is on screen, and a scheme resolves to a"
               " colour like anything else. Checking only that it is NOT BLANK"
               " passes against a swatch that quietly fell back to the main"
               " chain, which is what the first version of this did")
if pick.get("contactHasModes"):
    bad.append("the contact picker offers colour schemes - a contact is one"
               " line between two residues, and no scheme says what colour"
               " that line should be")
if not pick.get("contactHasAuto"):
    bad.append("the contact picker lost its Auto button, which is the only way"
               " it has to clear a colour")

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
