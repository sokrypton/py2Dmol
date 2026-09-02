"""The selection panel in the two shells that never had it.

    python3 tests/selection_shells.py

THE VERBS WERE IN EVERY BUNDLE AND ONE PAGE COULD REACH THEM. `setSelectionColor`,
the side-chain modes, the element toggle, the base plates, the SSE override, the
contacts, Find interactions - all of it was `src/app/selection.js` with two
hundred lines of markup in `index.html`, so the notebook and the embed carried
the machinery and had no control that touched it. The panel is data in
`parts/panel.js` now, mounted by `parts/ui.js`, and this measures it where it
has never run: on the page `_display_viewer` writes, and on a bare host page
that calls `py2Dmol.show(..., {controls: true})`.

What is measured, in both, and why each would pass against a half-done move:

  IT IS THERE, AND IT IS DRESSED. The rows exist and their controls have a
  real height and are not stacked - the forty-six CSS rules used to live in
  `src/app/style.css`, so a shell mounting this panel got correct markup and
  browser-default buttons. A presence check alone passes against that.

  A CLICK FILLS IT. `selectionEnabled` and the mount read ONE key, so a panel
  that appears while picking is off is the fault this pins. Measured as the
  panel going from hidden to shown after a canvas click, not by reading a flag.

  AND A CONTROL DOES SOMETHING. Colour is the one that reaches pixels with no
  other explanation: the count of that exact colour goes from zero to hundreds.
  A wired-up-but-dead panel opens and syncs perfectly.

  ...AND THE ICONS ARE DRAWN. The head's three actions were Font Awesome, which
  index.html loads and neither of these shells does - an icon button with no
  icon is an empty square that deletes things.

  OFF BY DEFAULT. Without `selection=True` there is no panel and a click picks
  nothing, which is every existing notebook.
"""
import http.server, json, os, shutil, socketserver, subprocess, sys, threading, time, types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
PORT = 9803          # ...its own, see the note in tests/msa_paired_ui.py

# viewer.py imports IPython at module scope and the suite's python has none -
# the same stub tests/minimal_input.py carries, and for the same reason: this
# probe wants the HTML _display_viewer writes, not a notebook.
try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, n, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import numpy as np       # noqa: E402
import py2Dmol           # noqa: E402

# WHAT THE PANEL LOOKS LIKE, from outside. Everything here is read off the live
# DOM rather than off the table that built it: the table is already checked in
# tests/interaction.js, and what a build can lose is exactly what a table
# cannot show.
MEASURE = """
  const panelState = (root) => {
    const panel = root.querySelector('#selectionPanel');
    if (!panel) return {present: false};
    const box = panel.getBoundingClientRect();
    const rows = {};
    for (const row of panel.querySelectorAll('.selection-panel-row')) {
      const r = row.getBoundingClientRect();
      const kids = [...row.children].map((c) => {
        const b = c.getBoundingClientRect();
        const inner = c.id ? null : c.querySelector('[id]');
        return {id: c.id || (inner && inner.id) || c.className,
                x: Math.round(b.left - r.left), w: Math.round(b.width),
                h: Math.round(b.height), top: Math.round(b.top - r.top),
                // ...a control the panel has deliberately withheld measures
                // 0x0, and that is a right answer: SSE is not offered in tube,
                // Plate only where there are nucleotides.
                right: Math.round(b.right - r.left),
                hidden: !!c.hidden || b.width === 0};
      });
      rows[row.id] = {hidden: !!row.hidden, h: Math.round(r.height), kids};
    }
    // ...and the head's three actions, each with the size of the mark inside it
    const acts = [...panel.querySelectorAll('.selection-panel-actions button')]
      .map((b) => {
        const mark = b.querySelector('svg') || b.querySelector('i');
        const mb = mark ? mark.getBoundingClientRect() : null;
        return {id: b.id, kind: mark ? mark.tagName.toLowerCase() : null,
                strokes: mark && mark.children ? mark.children.length : 0,
                w: mb ? Math.round(mb.width) : 0,
                h: mb ? Math.round(mb.height) : 0};
      });
    // WHAT ONLY THE PANEL'S OWN STYLESHEET SETS. Each of these is a value no
    // browser default and no shell of ours supplies, so together they say the
    // skin arrived - which a layout measurement cannot, because the layout is
    // the container's.
    // 🔴 FROM A ROW THAT IS SHOWING. The first .selection-panel-label in the
    // panel may sit in a row this selection has no use for - a nucleic
    // selection has no main chain to colour - and a hidden element measures
    // 0x0, which reads exactly like a stylesheet that never arrived.
    const liveRow = [...panel.querySelectorAll('.selection-panel-row')]
      .find((x) => !x.hidden && x.getBoundingClientRect().height > 0) || panel;
    const label = liveRow.querySelector('.selection-panel-label');
    // THE RADIUS IS THE WRAPPER'S, not the buttons'. The pair is one rounded
    // box with two flat halves inside it and `overflow: hidden` clipping them
    // to its corners, which is what makes the two read as one control - so
    // asking a BUTTON for its radius measures the wrong element and answers 0
    // whether the stylesheet arrived or not.
    // 🔴 THE OUTERMOST BOX, WHICH IS THE STRIP WHERE THERE IS ONE. This read
    // .selection-switch, and the radius has moved up a level: Show/Hide, Plate
    // and Elem are one segmented control now, so the border and the rounding
    // belong to the group and the pair inside it is flat by construction. A
    // check on the pair reports "browser-default buttons" against exactly the
    // arrangement that makes them not be.
    const swb = liveRow.querySelector('.selection-strip')
      || liveRow.querySelector('.selection-switch');
    const sw = liveRow.querySelector('.selection-swatch');
    const tools = panel.querySelector('.selection-tools');
    const swBox = sw ? sw.getBoundingClientRect() : null;
    const skin = {
      labelWidth: label ? Math.round(label.getBoundingClientRect().width) : null,
      // ...and its HEIGHT, which is a different question from its width and
      // was the one that failed: see the line-height note below.
      labelH: label ? Math.round(label.getBoundingClientRect().height) : 0,
      switchRadius: swb
        ? parseFloat(getComputedStyle(swb).borderTopLeftRadius) || 0 : 0,
      swatchW: swBox ? Math.round(swBox.width) : 0,
      swatchH: swBox ? Math.round(swBox.height) : 0,
      toolsFlex: tools ? getComputedStyle(tools).flexDirection === 'column' : false,
      // ...AND THE FORM IT TAKES. A card here is a bordered white box inside
      // the shell's own bordered white control column - two frames around one
      // stack of controls. The shared skin is the SECTION form; the website
      // puts its card back from its own stylesheet.
      shadow: getComputedStyle(panel).boxShadow,
      sideBorder: getComputedStyle(panel).borderLeftWidth,
      topBorder: getComputedStyle(panel).borderTopWidth,
      ground: getComputedStyle(panel).backgroundColor,
    };
    // ...AND WHAT THE SHELL'S OWN CONTROLS LOOK LIKE, so the panel can be
    // compared against its neighbours rather than against a number.
    const near = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {w: Math.round(b.width), h: Math.round(b.height),
              font: cs.fontSize, radius: cs.borderTopLeftRadius};
    };
    skin.shell = {
      styleSelect: near('#styleSelect'),
      colorSelect: near('#colorSelect'),
      caption: near('#stylePanel label'),
      toggle: near('#stylePanel .btn-toggle span'),
      button: near('#orientToggle') || near('.controlButton'),
      column: near('#rightPanelContainer'),
    };
    const host = panel.parentElement && panel.parentElement.parentElement;
    // where the panel's height actually goes
    const head = panel.querySelector('.selection-panel-head');
    const cs = getComputedStyle(panel);
    const budget = {
      panel: Math.round(panel.getBoundingClientRect().height),
      head: head ? Math.round(head.getBoundingClientRect().height) : 0,
      toolsH: tools ? Math.round(tools.getBoundingClientRect().height) : 0,
      panelGap: cs.gap, panelPadTop: cs.paddingTop,
      toolsGap: tools ? getComputedStyle(tools).gap : null,
      rowGap: tools ? getComputedStyle(tools.querySelector('.selection-panel-row') || tools).gap : null,
      rowW: tools && tools.querySelector('.selection-panel-row')
        ? Math.round(tools.querySelector('.selection-panel-row').getBoundingClientRect().width) : null,
    };
    return {present: true, hidden: !!panel.hidden, skin, budget,
            w: Math.round(box.width),
            hostW: host ? Math.round(host.getBoundingClientRect().width) : 1e9,
            rows, acts};
  };
  // 🔴 NOT A MATCH AGAINST THE TABLE VALUE. Shading moves every drawn colour
  // off it - a residue asked to be #ff0000 is painted somewhere between
  // (255,76,76) and (150,30,30) depending which way its surface faces - so a
  // tolerance tight enough to mean "this colour" excludes most of the ink and
  // a tolerance loose enough to catch it also catches the page. What has no
  // other explanation is DOMINANCE: red well ahead of both other channels,
  // which nothing on a grey-and-white page is.
  const reddish = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > d[i + 1] + 60 && d[i] > d[i + 2] + 60) n++;
    }
    return n;
  };
"""

# The gesture, not the flag: a click on the canvas where the structure is.
DRIVE = """
  const clickCanvas = async (r) => {
    const c = r.canvas;
    const b = c.getBoundingClientRect();
    // ...aim at a residue rather than at the middle of the box, by projecting
    // one. The renderer's own picker is what a real click goes through, so the
    // point has to land on ink.
    const opts = {bubbles: true, clientX: b.left + b.width / 2,
                  clientY: b.top + b.height / 2};
    c.dispatchEvent(new MouseEvent('mousedown', opts));
    c.dispatchEvent(new MouseEvent('mouseup', opts));
    await settle();
  };
"""

JS = """
<script>
// A THROW DURING THE PAGE'S OWN SETUP happens before any listener a probe can
// attach, so the trap goes first - see embed.html, which learned this from a
// dead line that threw on every load through a full green run.
window.__probeErrors = [];
window.addEventListener('error', (e) => window.__probeErrors.push(
  String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
window.addEventListener('load', () => {
  //HELPERS
  //MEASURE
  //DRIVE
  const go = async () => {
    const R = {};
    try {
      // ...WAIT FOR THE VIEWER, do not assume it. The two pages start at
      // different speeds - one inlines half a megabyte, the other fetches it -
      // and a fixed setTimeout read an empty map on the slower one.
      await until(() => Object.keys(window.py2dmol_viewers || {}).length > 0);
      const ids = Object.keys(window.py2dmol_viewers);
      const r = window.py2dmol_viewers[ids[0]].renderer;
      await until(() => r.coords && r.coords.length > 10);
      await settle();
      R.before = panelState(document);
      R.selectionEnabled = !!r.selectionEnabled;

      // A CLICK IS WHAT OPENS IT - and if picking is off, nothing happens,
      // which is the other half of the same key.
      await clickCanvas(r);
      // ...and on a nucleic structure, select NUCLEOTIDES, because Plate is
      // offered for those alone and it is the control this leg is about.
      if (r.positionTypes && r.positionTypes.some((t) => t === 'D' || t === 'R')) {
        const nt = [];
        for (let i = 0; i < r.positionTypes.length && nt.length < 4; i += 1) {
          if (r.positionTypes[i] === 'D' || r.positionTypes[i] === 'R') nt.push(i);
        }
        r.setResidueSelection(new Set(nt));
        await settle(); await settle();
        const show = document.getElementById('sidechainShowButton');
        if (show) { show.click(); await settle(); await settle(); }
      }
      R.picked = r.residueSelection ? r.residueSelection.size : 0;
      // ...OPEN THE STYLE PANEL BEFORE MEASURING ITS CONTROLS. It is hidden
      // until its button is pressed, and a hidden control measures 0x0 - which
      // is what the first version of this comparison read for all six.
      const styleBtn = document.getElementById('styleToggle')
        || document.getElementById('styleButton');
      if (styleBtn) { styleBtn.click(); await settle(); await settle(); }
      R.after = panelState(document);

      if (R.picked) {
        // ...and a control DOES something. Colour reaches pixels with no other
        // explanation; the count of that exact red goes none -> many.
        R.redBefore = reddish(r.canvas);
        // ...THROUGH THE PANEL'S SWATCH, not by calling the verb. A verb that
        // works with a dead button is the whole fault this move could have
        // shipped, so the click has to be the thing measured.
        document.getElementById('selColorButton').click();
        await settle();
        const cell = document.querySelector('#selColorMenu .selection-color-cell');
        R.hasSwatches = !!cell;
        if (cell) { cell.click(); await settle(); }
        R.swatchColor = cell ? cell.getAttribute('data-color')
          || getComputedStyle(cell).backgroundColor : null;
        R.redAfter = reddish(r.canvas);

        // ...and the panel's own SSE menu reads the structure back rather than
        // showing a placeholder, which is what says the sync ran.
        const ss = document.getElementById('selSsSelect');
        R.sse = ss ? ss.value : null;

        // ...and the side-chain row's Show button materialises atoms. It is
        // the row that needs a TABLE - view(sidechains=True) in a notebook,
        // the parser's own in an embed - so this is what says the data door
        // and the control door are both open.
        const n0 = r.coords.length;
        const show = document.getElementById('sidechainShowButton');
        R.hasShow = !!show;
        if (show) { show.click(); await settle(); }
        R.grew = r.coords.length - n0;
      }
    } catch (e) {
      R.error = String((e && e.stack) || e);
      R.pageErrors = window.__probeErrors || [];
      R.viewers = Object.keys(window.py2dmol_viewers || {});
    }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""
JS = JS.replace('//HELPERS', HELPERS).replace('//MEASURE', MEASURE).replace('//DRIVE', DRIVE)
check_js(JS)


def serve_and_measure(page_html, tag):
    """Write the page, drive it in headless Chrome, return what it posted."""
    probe = os.path.join(ROOT, '_selshell.html')
    open(probe, 'w').write(page_html)
    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a): pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(
                int(self.headers.get('Content-Length', 0)))))
            self.send_response(200); self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    prof = '/tmp/py2dmol-selshell-' + tag
    p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=' + prof,
                          '--no-first-run', '--window-size=1000,900',
                          f'http://127.0.0.1:{PORT}/_selshell.html'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end:
        time.sleep(0.4)
    p.kill(); httpd.shutdown()
    try: os.remove(probe)
    except OSError: pass
    shutil.rmtree(prof, ignore_errors=True)
    return box[0] if box else {'error': 'no result posted'}


FIXTURE = '1UBQ.cif'
# ...and a tRNA, for the row only a nucleotide has. Plate answers HOW a base is
# drawn and appears nowhere else.
NUCLEIC = '1EHZ.cif'


def notebook_page(selection, fixture=FIXTURE):
    """The page a notebook cell actually shows, with and without the flag.

    A REAL STRUCTURE, and `sidechains=True` with it. The first version used a
    synthetic CA-only helix, and two of the checks then failed against correct
    code: the side-chain row has nothing to show without a TABLE, which a
    notebook only has when it was asked for, and the SSE menu is withheld in
    tube. Both are the panel doing its job, and neither is measurable on a
    fixture that cannot exercise it.
    """
    # 🔴 THE SECOND VIEWER IN A PROCESS BORROWS. viewer.py records that this
    # kernel has lent the library once (_LENT_BUNDLE) and every later show()
    # writes a REQUEST to borrow it from the page instead of inlining a second
    # copy - which is the whole point of it, and which in a probe that serves
    # each page on its own means the second page has no library, no viewer and
    # no error to show for it. Two legs, two lends.
    py2Dmol.viewer._LENT_BUNDLE = None
    py2Dmol.viewer._LENT_WHERE = None
    # 🔴 AN ID THAT STARTS WITH A DIGIT, PINNED. viewer.py wraps each viewer in
    # `<div id="{uuid4}">` and parts/ui.js scopes the panel's stylesheet to that
    # id - and `#3f2b...` is not a valid CSS selector, so every rule under it is
    # dropped and the panel comes up in browser defaults. A uuid4 starts with a
    # digit about six times in ten, so this probe passed twice and failed on the
    # third run against unchanged code. Naming the id makes the hard case the
    # only case.
    v = py2Dmol.view(size=(360, 360), selection=selection, style='richardson',
                     sidechains=True,
                     id='7selshell-' + os.path.basename(fixture).split('.')[0]
                     + ('on' if selection else 'off'))
    v._is_live = False
    v.add_pdb(os.path.join(ROOT, fixture), name='obj', use_biounit=False)
    body = v._display_viewer(static_data=v.objects)
    return ('<!doctype html><html><head><meta charset="utf-8"></head><body>'
            + body + JS + '</body></html>')


def embed_page(fixture=FIXTURE):
    """A bare host page that asks for chrome - no Font Awesome, no style.css.

    THAT IS THE POINT OF THIS LEG: the panel's forty-six rules and its three
    icons used to be index.html's, so a host page got working markup dressed in
    nothing and three empty squares, one of which deletes things.
    """
    return ("""<!doctype html><html><head><meta charset="utf-8">
<title>embed selection panel</title></head><body>
<div id="host"></div>
<script src="/py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
fetch('/""" + fixture + """').then((r) => r.text()).then((text) => {
  py2Dmol.show(document.getElementById('host'), text,
               {controls: true, width: 360, height: 360, style: 'richardson'});
});
</script>
""" + JS + """
</body></html>""")


bad = []


def judge(tag, R, want_panel, nucleic=False):
    print(f"\n  --- {tag} ---")
    if R.get('error'):
        bad.append(f'{tag}: page error: {R["error"]}'
                   f'  viewers={R.get("viewers")}'
                   f'  page errors={R.get("pageErrors")}')
        return
    before, after = R.get('before') or {}, R.get('after') or {}
    print(f"  picking={R.get('selectionEnabled')} panel present="
          f"{before.get('present')} -> after a click hidden={after.get('hidden')}"
          f" picked={R.get('picked')}")

    if not want_panel:
        # OFF BY DEFAULT IS THE OTHER HALF OF THE KEY. Every notebook that
        # exists today is this case, and a panel arriving in it - never
        # opening, because a click picks nothing - is the "control the shared
        # panel shows and no shell wires" fault by another route.
        if before.get('present'):
            bad.append(f'{tag}: the panel is mounted without being asked for')
        if R.get('selectionEnabled'):
            bad.append(f'{tag}: a click picks a residue with no panel to show it')
        if R.get('picked'):
            bad.append(f'{tag}: a click selected {R["picked"]} residues anyway')
        return

    if not before.get('present'):
        bad.append(f'{tag}: no selection panel was mounted at all')
        return
    if not before.get('hidden'):
        bad.append(f'{tag}: the panel is showing with nothing selected')
    if not R.get('picked'):
        bad.append(f'{tag}: a click picked nothing - the panel can never open')
    if after.get('hidden'):
        bad.append(f'{tag}: the panel stayed hidden after a residue was picked')

    # IT IS DRESSED, AND THAT IS A COMPUTED STYLE, NOT A LAYOUT.
    #
    # 🔴 The first version of this asked whether the rows wrapped, and both new
    # shells fail that while being perfectly correct: index.html gives the
    # panel its own ~340px column, viewer.html's right-hand panel is 180px wide
    # and the embed's 190, and in those every row of those shells' OWN controls
    # wraps too. Measuring layout here measured the container.
    #
    # What actually went missing when the forty-six rules were src/app/'s alone
    # is the SKIN: a fixed-width caption so the rows line up under each other,
    # a rounded switch, a swatch with a size, a column of rows. None of those
    # is a browser default and none depends on how wide the column is.
    skin = after.get('skin') or {}
    shell = skin.pop('shell', None) or {}
    shell = skin.pop('shell', None) or {}
    print('  panel skin: ' + ', '.join(f'{k}={v}' for k, v in sorted(skin.items())))
    for k, v in shell.items():
        print(f"    shell {k:12} {v}")
    # 🔴 THE CAPTION IS A FIXED 66px, ON THE ROW. It has been three things
    # here: the card's 74, then the full width of the panel when it needed a
    # line to itself, and now 66 inline again - because the row was only ever
    # too narrow for it while each control carried 10px a side of label padding
    # outside its own face. Fixed, so the rows line up under each other; 66
    # because that is what the widest caption needs ("Side chains" is 59px in
    # viewer.html's font and 65 in the embed's) and one pixel more than the
    # notebook's 170px row can spare anywhere else.
    if skin.get('labelWidth') != 66:
        bad.append(f'{tag}: the row caption is {skin.get("labelWidth")}px, not'
                   ' the stated 66 - either the stylesheet did not arrive or the'
                   ' rows no longer line up under each other')
    # 🔴 THE CAPTION'S HEIGHT, NOT ONLY ITS WIDTH. viewer.py wraps every
    # notebook viewer in `line-height: 0` - correct for a div holding a canvas,
    # since an inline-block leaves a text gap under it - and it INHERITS. Every
    # caption came out 74px wide and 0 high: each row showed its controls with
    # no name, in the notebook only, while the width said the stylesheet had
    # arrived. A width check alone passes against it.
    if (skin.get('labelH') or 0) < 10:
        bad.append(f'{tag}: the row caption is {skin.get("labelH")}px high -'
                   ' the rows have controls and no names')
    if not skin.get('switchRadius'):
        bad.append(f'{tag}: the Show/Hide buttons have no border radius - they'
                   ' are browser-default buttons')
    if (skin.get('swatchW') or 0) < 8 or (skin.get('swatchH') or 0) < 8:
        bad.append(f'{tag}: the colour swatch is'
                   f' {skin.get("swatchW")}x{skin.get("swatchH")}px')
    if not skin.get('toolsFlex'):
        bad.append(f'{tag}: .selection-tools is not a flex column, so the rows'
                   ' are not stacked as rows at all')

    # 🔴 A SECTION, NOT A CARD. Reported as "it still appears as a separate
    # panel": in a 180px or 190px control column the card put a second border
    # and a second white ground around controls that are already inside one.
    # What says "a new group starts here" in a column is a hairline, which is
    # the same device the panel already uses between its properties and its
    # actions.
    if skin.get('shadow') not in (None, 'none'):
        bad.append(f'{tag}: the panel casts a shadow ({skin.get("shadow")}) -'
                   ' it is a card inside the shell\'s own card')
    if skin.get('sideBorder') not in (None, '0px'):
        bad.append(f'{tag}: the panel has a {skin.get("sideBorder")} side border'
                   ' - a second frame around one column of controls')
    if skin.get('ground') not in (None, 'rgba(0, 0, 0, 0)', 'transparent'):
        bad.append(f'{tag}: the panel paints its own ground'
                   f' ({skin.get("ground")}) rather than sitting on the column\'s')
    if skin.get('topBorder') in (None, '0px'):
        bad.append(f'{tag}: there is no hairline above the panel, so it runs'
                   ' into the buttons over it with nothing to say a new group'
                   ' has started')

    # 🔴 EVERY ROW IS A CAPTION AND THEN ONE LINE OF CONTROLS.
    #
    # Reported as "the buttons are not on the same row, and the style differs
    # from the others". Both halves had one cause: this panel is sized for the
    # 340px card it has on the website, and these shells give it 180px and 190.
    # The caption was 74px against the shell's own 52 and the controls 26px
    # against its 24 - so a row could not fit and broke wherever it happened to,
    # leaving a caption and a lone swatch on one line with the switch on the
    # next, and the main-chain row on THREE.
    #
    # A 180px column cannot hold a caption, a swatch, a Show/Hide pair and a
    # select side by side; that is arithmetic, not styling. So the caption takes
    # the whole first line and the controls share the second - which uses the
    # width and reads as a labelled group. This asserts that shape: the caption
    # alone on top, every control of the row on ONE line beneath it, at the
    # height the shell uses for its own controls.
    wantH = ((shell.get('styleSelect') or {}).get('h'))
    for rid, row in (after.get('rows') or {}).items():
        if row['hidden']:
            continue
        kids = [k for k in row['kids'] if not k['hidden']]
        caps = [k for k in kids if 'selection-panel-label' in str(k['id'])]
        # ...the line break is LAYOUT, not a control - zero-height and full
        # width, which every check below would read as a broken one.
        ctrls = [k for k in kids if k not in caps]
        if not ctrls:
            continue
        # 🔴 ONE LINE WHERE THE ROW CAN HOLD ONE. A caption, a swatch and one
        # control fit the notebook's 170px row; a fourth does not, and no
        # styling makes it - the main chain's SSE menu and a nucleotide's Plate
        # are the two that wrap. So the rule is by CONTENT: two controls beside
        # the caption must be one line, three may be two, and nothing may be
        # three.
        tops = sorted({k['top'] for k in ctrls})
        limit = 1 if len(ctrls) <= 2 else 2
        if len(tops) > limit:
            bad.append(f'{tag}: {rid} puts {len(ctrls)} controls on'
                       f' {len(tops)} lines where {limit} should do'
                       f' (tops {tops}) - '
                       + ', '.join(f"{k['id']}@y{k['top']}" for k in ctrls))
        if wantH:
            odd = [f"{k['id']}:{k['h']}px" for k in ctrls if abs(k['h'] - wantH) > 1]
            if odd:
                bad.append(f'{tag}: {rid} has controls at {odd} where the'
                           f" shell's own are {wantH}px - the panel is still"
                           ' wearing its card metrics in a control column')

    # 🔴 PLATE SITS AFTER SHOW/HIDE, ON THE SAME LINE, AS AN ORDINARY BUTTON.
    #
    # Show/Hide says whether a nucleotide's base is drawn; Plate says how. They
    # belong side by side, and the row is one line.
    #
    # THREE SHAPES WERE TRIED BEFORE THIS ONE, and the history is the reason
    # this check is about POSITION rather than about pixels of styling. Elem
    # falling to a second line at x0 was the report; giving Plate and Elem a
    # line of their own fixed it and read as two answers to one question;
    # welding all three into one segmented strip fixed THAT and read as partial
    # buttons, because a group with one border makes its members flat and they
    # stop looking like controls. What is left is the simplest thing: ordinary
    # rounded buttons, with the width found in the caption and the padding.
    if nucleic:
        sc = (after.get('rows') or {}).get('sidechainRow') or {}
        kids = {str(k['id']): k for k in sc.get('kids', []) if not k['hidden']}
        pair = kids.get('sidechainPair')
        plate = kids.get('plateShowToggle')
        print(f"  nucleotide row: {sc.get('h')}px, "
              + ', '.join(f"{n}@x{k['x']}..{k['right']}"
                          for n, k in kids.items()
                          if n in ('sidechainPair', 'plateShowToggle',
                                   'elementsShowToggle')))
        if not plate:
            bad.append(f'{tag}: no Plate control on a nucleic selection - this'
                       ' leg is measuring nothing')
        elif not pair:
            bad.append(f'{tag}: no Show/Hide pair beside it')
        elif plate['top'] == pair['top'] and plate['x'] < pair['right']:
            bad.append(f'{tag}: Plate overlaps the pair - x{plate["x"]} against'
                       f' its right edge at {pair["right"]}')
        # 🔴 AND NOT "BESIDE THE PAIR", WHICH IS THE CARD'S ANSWER. A caption, a
        # swatch, Show/Hide AND Plate want 221px of a 180px row, so here Plate
        # takes the line below - exactly as the main chain's SSE menu does, and
        # for the same reason. Whether that wrap is allowed at all is the row
        # rule above, by content: two controls beside the caption must be one
        # line, three may be two. Where the five DO fit is the 322px card, and
        # tests/selection_panel.py measures the placement there.

    # 🔴 AND THE WHOLE PANEL IS COMPACT, which is a thing only a total can say.
    # Every row measured right and the panel still stood 193px tall, because the
    # caption had a line of its own on every one of them. Inline it is 152. The
    # bound is generous enough not to fail on a fixture with one more row and
    # tight enough that giving every caption a line again would trip it.
    budget = after.get('budget') or {}
    print('  budget: ' + ', '.join(f'{k}={v}' for k, v in sorted(budget.items())))
    if (budget.get('panel') or 0) > 170:
        bad.append(f'{tag}: the panel is {budget.get("panel")}px tall for'
                   f' {len(after.get("rows") or {})} rows - it was 193 when'
                   ' every caption took a line of its own, and 152 without')

    # ...AND NOTHING HANGS OUT OF THE SIDE. Wrapping is fine; a control wider
    # than the panel is not, and a stated 340px width with no ceiling did
    # exactly that in both of these shells.
    for rid, row in (after.get('rows') or {}).items():
        if row['hidden']:
            continue
        kids = [k for k in row['kids']
                if not k['hidden'] and not str(k['id']).endswith('Break')]
        print(f"  {rid}: {row['h']}px, controls "
              + ', '.join(f"{k['id']}:{k['w']}x{k['h']}@y{k['top']}" for k in kids))
        for k in kids:
            if k['w'] > after.get('w', 0) + 2:
                bad.append(f'{tag}: {k["id"]} is {k["w"]}px in a'
                           f' {after.get("w")}px panel - it hangs out of the side')
            if k['h'] < 12:
                bad.append(f'{tag}: {k["id"]} is {k["w"]}x{k["h"]}px - unstyled')
    if after.get('w', 0) > after.get('hostW', 10 ** 9) + 2:
        bad.append(f'{tag}: the panel is {after.get("w")}px inside a'
                   f' {after.get("hostW")}px column')

    # ...AND THE ICONS ARE DRAWN. Font Awesome is index.html's; these two pages
    # load no icon font at all, which is why they are inline SVG.
    acts = after.get('acts') or []
    print('  head actions: ' + ', '.join(
        f"{a['id']} {a['kind']}({a['strokes']}) {a['w']}x{a['h']}" for a in acts))
    if len(acts) != 3:
        bad.append(f'{tag}: the head has {len(acts)} actions, expected Copy,'
                   ' Cut and Delete')
    for a in acts:
        if a['w'] < 8 or a['h'] < 8 or not a['strokes']:
            bad.append(f'{tag}: {a["id"]} has no drawn mark ({a["kind"]},'
                       f' {a["strokes"]} strokes, {a["w"]}x{a["h"]}px) - an icon'
                       ' button with no icon is an empty square that deletes things')

    # A CONTROL DOES SOMETHING, measured on the canvas.
    print(f"  red pixels {R.get('redBefore')} -> {R.get('redAfter')};"
          f" SSE menu {R.get('sse')!r}; Show added {R.get('grew')} atoms")
    if not R.get('redAfter') or R['redAfter'] <= (R.get('redBefore') or 0) + 50:
        bad.append(f'{tag}: colouring the selection reached'
                   f' {R.get("redAfter")} red pixels against'
                   f' {R.get("redBefore")} before - the panel is inert')
    if not R.get('sse'):
        bad.append(f'{tag}: the SSE menu is blank - updateSelectionToolsState'
                   ' never ran, so the panel shows nothing about the selection')
    # 🔴 ONLY FOR A PROTEIN. Show on a nucleotide draws a base PLATE - geometry
    # built from atoms that are already there - so the coordinate array does not
    # grow, and asking it to was this check reading one row's meaning into
    # another's.
    if not nucleic and not R.get('grew'):
        bad.append(f'{tag}: the side-chain Show button materialised no atoms')


judge('notebook, selection=True', serve_and_measure(notebook_page(True), 'nb'), True)
judge('embed, tRNA', serve_and_measure(embed_page(NUCLEIC), 'emb-rna'), True,
      nucleic=True)
judge('notebook, default', serve_and_measure(notebook_page(False), 'nboff'), False)
judge('embed, controls=true', serve_and_measure(embed_page(), 'emb'), True)

print()
if bad:
    for b in bad:
        print('FAIL: ' + b)
    sys.exit(1)
print('ok')
