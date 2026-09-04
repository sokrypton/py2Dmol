"""render.html - drop a folder of structures in, get every picture out.

    python3 tests/render_page.py

The page is the answer for anyone who is not in Python (view.save_image and
examples/batch_render.py are the answer for anyone who is). It reads the files
in the browser, renders them through ONE viewer - a viewer per structure is the
whole cost - and hands back a zip.

Driven the way a reader drives it: a real `drop` event carrying real File
objects, then the same renderAll() every button on the page goes through, so
this measures the page and not a second copy of it.

What is checked:

  * a drop is what loads the files, and a .zip of them is unpacked;
  * the preview draws;
  * renderAll() returns one image per file, and the PNG HAS INK IN IT - a
    viewer that drew nothing writes a well-formed PNG of the right size;
  * the format menu reaches the exporter (SVG comes back as vector text);
  * 🔴 and the Paper menu reaches it too. `transparent` is derived from that
    one control, so a page offering White while exporting a cut-out is two
    answers to one question.
"""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import cdp  # noqa: E402

PORT = 8946
CDP_PORT = 9346
fails = []


def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok:
        fails.append(msg)


def serve(port):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, *a):
            pass

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# A REAL DROP. The page never sees these as anything but files a person let go
# of over it - which is the only entrance it has, so a probe that called
# addText() would be testing a door nobody uses.
DROP = """
(async () => {
  const names = %s;
  const dt = new DataTransfer();
  for (const n of names) {
    const text = await (await fetch('/' + n)).text();
    dt.items.add(new File([text], n, { type: 'chemical/x-cif' }));
  }
  document.dispatchEvent(new DragEvent('drop', {
      dataTransfer: dt, bubbles: true, cancelable: true }));
  const t0 = Date.now();
  const B = window.py2dmolBatch;
  while (Date.now() - t0 < 15000 && B.files.length < names.length)
    await new Promise((s) => setTimeout(s, 50));
  return B.files.map((f) => f.name);
})()"""

# The image the page would have saved, measured: its size and how much of it
# is not empty.
IMAGE = """
(async () => {
  const B = window.py2dmolBatch;
  const made = await B.renderAll();
  const read = (blob) => new Promise((s) => {
      const fr = new FileReader(); fr.onload = () => s(fr.result);
      fr.readAsDataURL(blob); });
  const out = [];
  for (const m of made) {
    const url = await read(m.blob);
    const rec = { name: m.name, size: m.blob.size, head: url.slice(0, 32) };
    if (/\\.png$/.test(m.name)) {
      const img = new Image();
      await new Promise((s, j) => { img.onload = s; img.onerror = j; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
      Object.assign(rec, { w: img.width, h: img.height, ink,
                           px: img.width * img.height });
    } else {
      rec.text = atob(url.split(',')[1]).slice(0, 400);
    }
    out.push(rec);
  }
  return out;
})()"""


def main():
    profile = '/tmp/py2dmol-render-page-%d' % os.getpid()
    httpd = serve(PORT)
    proc, ws = cdp.launch(CDP_PORT, profile)
    try:
        ws.call('Runtime.enable')
        ws.call('Page.enable')
        ws.call('Page.navigate', url='http://127.0.0.1:%d/render.html' % PORT)
        cdp.wait_for(ws, "!!(window.py2dmolBatch && window.py2Dmol && "
                         'document.getElementById(\'go\'))', 40,
                     'the page never finished loading')

        names = cdp.evaluate(ws, DROP % json.dumps(['1UBQ.cif', '3CHY.cif']))
        check(names == ['1UBQ.cif', '3CHY.cif'],
              'a drop loads the files: %r' % (names,))
        check(cdp.evaluate(ws, 'document.getElementById("go").disabled') is False,
              'and Render comes alive')
        opened = cdp.evaluate(ws, 'py2dmolBatch.viewer.style + "/" '
                                  '+ py2dmolBatch.viewer.stylePreset')
        check(opened == 'cartoon/richardson',
              'a figure page opens on a cartoon, not the library tube: %r'
              % (opened,))

        # 🔴 DETAIL OPENS AT THE MAXIMUM, and this is asked while the
        # cartoon is up: cartoonDetail is a STYLE_SETTING, so a switch to
        # tube installs tube's own profile and the number read back is no
        # longer the cartoon's. Every picture here is a still, so
        # the reason to default it low - a viewer being dragged - does not
        # apply, and the control has to AGREE with the renderer.
        det = cdp.evaluate(ws, """(() => {
            const sl = document.getElementById('viewer')
                         .querySelector('#detailSlider');
            return { slider: sl && sl.value, max: sl && sl.max,
                     renderer: py2dmolBatch.viewer.cartoonDetail };
        })()""")
        check(det['slider'] == det['max']
              and str(det['renderer']) == str(det['max']),
              'Detail opens at the maximum, panel and renderer agreeing: %r'
              % (det,))

        # Small and cheap: this is measuring the wiring, not the renderer.
        cdp.evaluate(ws, """(() => {
            const set = (id, v) => {
              const el = document.getElementById(id);
              el.value = v;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            set('w', 200); set('h', 200); set('dpi', 96); set('format', 'png');
            const t = document.getElementById('transparent');
            t.checked = true;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()""")
        time.sleep(0.4)

        shots = cdp.evaluate(ws, IMAGE, True)
        check(len(shots) == 2, 'renderAll returns one image per file: %d'
              % len(shots))
        check(all(s['name'].endswith('.png') for s in shots),
              'named after the structure: %s'
              % ', '.join(s['name'] for s in shots))
        check(all(s['head'].startswith('data:image/png') for s in shots),
              'and they really are PNGs')
        one = shots[0]
        check(190 <= one['w'] <= 210 and one['w'] == one['h'],
              'at the size the menu asked for: %dx%d' % (one['w'], one['h']))
        check(one['ink'] > 200,
              'with ink in it: %d opaque pixels of %d' % (one['ink'], one['px']))
        check(one['ink'] < one['px'],
              'and the ground is cut out (%d of %d)' % (one['ink'], one['px']))

        # 🔴 THE PAPER MENU IS THE ONE CONTROL, and `transparent` is derived
        # from it - two controls would be two answers to one question.
        cdp.evaluate(ws, """(() => {
            const el = document.getElementById('transparent');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true; })()""")
        time.sleep(0.4)
        check(cdp.evaluate(ws, 'py2dmolBatch.imageOpts().transparent')
              is False, 'unticking Transparent background turns the cut-out off')
        papered = cdp.evaluate(ws, IMAGE, True)[0]
        check(papered['ink'] == papered['px'],
              'and every pixel is painted: %d of %d'
              % (papered['ink'], papered['px']))

        # 🔴 AND IT HAS TO SHOW IN THE PREVIEW, which is the whole point of a
        # preview: reported as the ground choice doing nothing on screen. The
        # canvas's own corner is the measurement - the checker behind it is
        # only visible THROUGH a transparent canvas.
        corner = """(() => {
            const c = document.getElementById('viewer').querySelector('#canvas');
            const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
            return { alpha: d[3],
                     checker: document.getElementById('viewer')
                                .classList.contains('clear') };
        })()"""
        lit = cdp.evaluate(ws, corner)
        check(lit['alpha'] == 255 and not lit['checker'],
              "the preview paints the background: %r" % (lit,))
        cdp.evaluate(ws, """(() => {
            const el = document.getElementById('transparent');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true; })()""")
        time.sleep(0.4)
        cut = cdp.evaluate(ws, corner)
        check(cut['alpha'] == 0 and cut['checker'],
              'and shows the cut-out as a cut-out: %r' % (cut,))

        cdp.evaluate(ws, """(() => {
            const el = document.getElementById('format');
            el.value = 'svg';
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true; })()""")
        time.sleep(0.4)
        vec = cdp.evaluate(ws, IMAGE, True)[0]
        check(vec['name'].endswith('.svg'), 'the format menu names the file %s'
              % vec['name'])
        check('<svg' in vec['text'], 'and what comes back is vector')

        # 🔴 THE LOOK IS THE PANEL'S, AND IT HAS TO SURVIVE THE NEXT FILE.
        # The page mounts the shipped Style panel and swaps each structure into
        # ONE renderer with load(); a viewer rebuilt per file would reset every
        # control in it, which is the whole reason for that design.
        panel = cdp.evaluate(ws, """(() => {
            const box = document.getElementById('viewer');
            return { panel: !!box.querySelector('#stylePanel'),
                     style: !!box.querySelector('#styleSelect'),
                     color: !!box.querySelector('#colorSelect'),
                     detail: !!box.querySelector('#detailSlider'),
                     // ...OPEN, and with the toolbar gone: the panel is the
                     // whole of what this page borrows from the shell.
                     open: !box.querySelector('#stylePanel').hidden,
                     noToolbar: !box.querySelector('#styleToggle')
                                && !box.querySelector('#saveImageButton'),
                     // Sele marks a selection and nothing here can make one.
                     noDeadRow: !box.querySelector('#selectionMarkSelect') };
        })()""")
        check(all(panel.values()),
              'the shipped Style panel is mounted, open, and alone: %r' % (panel,))

        was = cdp.evaluate(ws, """(() => {
            const box = document.getElementById('viewer');
            const sel = box.querySelector('#styleSelect');
            sel.value = 'tube';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            window.__vid = py2dmolBatch.viewer;
            return py2dmolBatch.viewer.style;
        })()""")
        check(was == 'tube', 'a style chosen in the panel takes: %r' % (was,))

        cdp.evaluate(ws, """(() => {
            const el = document.getElementById('format');
            el.value = 'png';
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true; })()""")
        after = cdp.evaluate(ws, """
        (async () => {
          await py2dmolBatch.renderAll();
          return { style: py2dmolBatch.viewer.style,
                   same: py2dmolBatch.viewer === window.__vid,
                   objects: Object.keys(py2dmolBatch.viewer.objectsData) };
        })()""", True)
        check(after['same'], 'every file goes through the same renderer')
        check(after['style'] == 'tube',
              'and the look is still the one that was chosen: %r'
              % (after['style'],))
        check(after['objects'] == ['structure'],
              'one object, replaced rather than appended: %r'
              % (after['objects'],))

        # 🔴 EVERY FILE IS ORIENTED, WHICH IS WHY THE SWITCH EXISTS. load()
        # turns each structure to face the reader - a folder of unrelated
        # proteins comes out as pictures rather than crystal settings - and
        # that is exactly wrong for a series of ALIGNED structures, where the
        # point is that they share a frame.
        view = cdp.evaluate(ws, """
        (async () => {
          const B = window.py2dmolBatch;
          const rot = () => JSON.stringify(B.viewer.viewerState.rotation);
          const set = (best) => { const el = document.getElementById('bestview');
            el.checked = best;
            el.dispatchEvent(new Event('change', { bubbles: true })); };
          // a rotation nobody's best view would land on
          const mine = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
          set(false);
          B.viewer.viewerState.rotation = mine.map((r) => r.slice());
          await B.preview(1);
          const kept = rot();
          set(true);
          B.viewer.viewerState.rotation = mine.map((r) => r.slice());
          await B.preview(0);
          const oriented = rot();
          set(true);
          return { mine: JSON.stringify(mine), kept, oriented };
        })()""", True)
        check(view['kept'] == view['mine'],
              'Keep this view carries the camera onto the next file')
        check(view['oriented'] != view['mine'],
              'and Best view turns each one to face the reader: %s'
              % (view['oriented'][:40],))

        # 🔴 A THOUSAND FILES IS THE CASE THIS PAGE IS FOR. The list is built
        # once and mutated afterwards - rebuilding it to write one status is
        # O(n) per file and O(n^2) over a run - and the box scrolls rather
        # than growing the page.
        many = cdp.evaluate(ws, """
        (async () => {
          const B = window.py2dmolBatch;
          document.getElementById('clear').click();
          const text = await (await fetch('/1UBQ.cif')).text();
          for (let i = 0; i < 400; i++)
            B.addFile('s' + String(i).padStart(4, '0') + '.cif',
                      () => Promise.resolve(text));
          const t0 = performance.now();
          B.growList();
          const built = performance.now() - t0;
          const ul = document.getElementById('files');
          const node = ul.children[3];
          B.files[3].status = 'done';
          B.markRow(3);   // the call the batch itself makes, per file
          return { rows: B.rows.length, kids: ul.children.length,
                   scrolls: ul.scrollHeight > ul.clientHeight + 20,
                   clientH: ul.clientHeight, scrollH: ul.scrollHeight,
                   sameNode: ul.children[3] === node, built: Math.round(built),
                   marked: ul.children[3].querySelector('.st').textContent };
        })()""", True)
        check(many['rows'] == 400 and many['kids'] == 400,
              '400 files make 400 rows: %r' % (many['rows'],))
        check(many['scrolls'],
              'and the list scrolls inside its box (%dpx of %dpx)'
              % (many['clientH'], many['scrollH']))
        check(many['sameNode'] and many['marked'] == 'done',
              'a status is written INTO the row, not by rebuilding the list')

        # 🔴 AND A FILE IS A NAME AND A WAY TO READ IT. A thousand structures
        # held as strings is a gigabyte of heap for something the browser
        # already has on disk, and reading them all up front is a wait before
        # anything is on screen. Measured through the page's own ingest, with
        # a reader that counts.
        lazy = cdp.evaluate(ws, """
        (async () => {
          const B = window.py2dmolBatch;
          document.getElementById('clear').click();
          window.__reads = 0;
          const text = await (await fetch('/1UBQ.cif')).text();
          const mk = (n) => ({ name: n,
              text: () => { window.__reads++; return Promise.resolve(text); } });
          await B.ingest([mk('lazy1.cif'), mk('lazy2.cif'), mk('lazy3.cif')]);
          const afterDrop = window.__reads;
          await B.preview(2);
          return { afterDrop, afterPreview: window.__reads,
                   files: B.files.length };
        })()""", True)
        check(lazy['files'] == 3, 'three files in: %r' % (lazy['files'],))
        # ONE read for a drop of three - the one it puts on screen - and one
        # more when another is asked for. Eagerly, it would be three and three.
        check(lazy['afterDrop'] == 1,
              'a drop reads the file it shows and no other: %d of 3'
              % (lazy['afterDrop'],))
        check(lazy['afterPreview'] == 2,
              'and the rest stay unread until something asks: %d'
              % (lazy['afterPreview'],))
        cdp.evaluate(ws, 'document.getElementById("clear").click()')

        # A zip of structures is one file to drag, which is how a thousand of
        # them arrive. Skipped rather than failed with no JSZip - it is a CDN
        # script and the lane may have no network.
        if cdp.evaluate(ws, 'typeof JSZip !== "undefined"'):
            got = cdp.evaluate(ws, """
            (async () => {
              const B = window.py2dmolBatch;
              document.getElementById('clear').click();
              const zip = new JSZip();
              zip.file('a/one.cif', await (await fetch('/1UBQ.cif')).text());
              zip.file('a/two.cif', await (await fetch('/3CHY.cif')).text());
              zip.file('a/readme.md', 'not a structure');
              const blob = await zip.generateAsync({ type: 'blob' });
              const dt = new DataTransfer();
              dt.items.add(new File([blob], 'bundle.zip'));
              document.dispatchEvent(new DragEvent('drop', {
                  dataTransfer: dt, bubbles: true, cancelable: true }));
              const t0 = Date.now();
              while (Date.now() - t0 < 15000 && !B.files.length)
                await new Promise((s) => setTimeout(s, 50));
              return B.files.map((f) => f.name);
            })()""")
            check(got == ['one.cif', 'two.cif'],
                  'a dropped zip is unpacked, and only the structures: %r'
                  % (got,))
        else:
            print('  --   JSZip did not load; the zip leg is skipped')
    finally:
        proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    print('FAIL' if fails else 'PASS')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
