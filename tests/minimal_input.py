"""The bare minimum: an Nx3 array of CA coordinates and nothing else.

    python3 tests/minimal_input.py

`view.add(coords)` is the Python API's smallest call - no chains, no residue
names, no atom names, no types, no side-chain table. Everything downstream has
to cope: the cartoon has to predict a backbone to build a ribbon from, the SS
assignment has to work off the trace, and the panel has to answer its
questions without inventing data it has not got.

It is also where a change made for the web app can quietly break the notebook:
the web loads a full PDB, so a reader that assumes atom names or a side-chain
table is present will never fail there.

What this checks, in a browser, on the page `_display_viewer` writes:

  * both styles draw something from coordinates alone;
  * the SS assignment answers - a CA trace is what predictBackbone exists for;
  * asking for it repeatedly is CHEAP, because the panel asks on every click;
  * the pieces that need data that is absent are absent themselves, rather
    than throwing or drawing nothing.

It has since become the probe for THE PAYLOAD, FIELD BY FIELD, because it is
the one that builds through `_display_viewer` with a fixture small enough to
state an expected answer for. `align`, the per-atom columns and `pae_n` were
each dropped by a field-by-field frame builder on one side or the other, and
each is checked here now - along with the PAE's wire format (base64, and
resampled to what the panel can draw), the SVG export's shading, and the
open-panel cue on the Capture button.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, types, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_minimal.html')

try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, n, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import numpy as np
import py2Dmol

JS = """
<script>
window.addEventListener('load', () => {
  const ink = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
    }
    return n;
  };
  //HELPERS
  const go = async () => {
    const R = {errors: []};
    window.addEventListener('error', (e) => R.errors.push(String(e.message)));
    try {
      const key = Object.keys(window.py2dmol_viewers)[0];
      const r = window.py2dmol_viewers[key].renderer;
      // NOT `r.useGPU = false` ANY MORE. This used to pin the CPU path so the
      // SSE timings below could not be blamed on a driver - but the notebook
      // bundle now ships cartoon/paintgl.js and no 2D painter, so switching the
      // GPU off leaves the cartoon with nothing to draw it and this probe
      // reported "cartoon drew nothing from a bare CA trace" against a viewer
      // that was working. The timings are unaffected either way: assignedSseFor
      // is geometry, and no painter is involved in it.
      await settle();
      const all = [];
      for (let i = 0; i < r.coords.length; i++) all.push(i);

      const look = async (style) => {
        r.setStyle(style);
        await settle();
        // ...the assignment, the way the panel asks for it
        // ONE RESIDUE AT A TIME, and a tally: '' from a RANGE means the
        // residues disagree, which is a real answer and not a failure - the
        // start of a helix is coil. What matters here is whether a CA trace
        // gets an assignment at all.
        const t0 = performance.now();
        const first = r.assignedSseFor([Math.floor(r.coords.length * 0.25)]);
        const t1 = performance.now();
        const tally = {};
        for (let i = 0; i < r.coords.length; i++) {
          const one = r.assignedSseFor([i]) || '?';
          tally[one] = (tally[one] || 0) + 1;
        }
        let repeat = 0;
        for (let k = 0; k < 20; k++) r.assignedSseFor(all.slice(0, 5));
        const t2 = performance.now();
        repeat = (t2 - t1) / 20;
        return {style, ink: ink(r.canvas), n: r.coords.length,
                sse: first, tally, coldMs: Math.round((t1 - t0) * 100) / 100,
                warmMs: Math.round(repeat * 1000) / 1000,
                // ...and over the WHOLE structure, which is what a Select all
                // followed by a click costs
                allMs: (() => { const a = performance.now();
                  r.assignedSseFor(all); return Math.round((performance.now() - a) * 100) / 100; })()};
      };
      // THE NOTEBOOK OPENS FACING THE READER, and since best_view left
      // viewer.py that is parts/orient.js's job rather than numpy's. An
      // unoriented viewer looks like a viewer, so the only way to see this
      // regress is to ask whether anything turned it.
      R.orient = {
        module: !!window.py2dmolOrient,
        fromPython: !!(r.objectsData[r.currentObjectName] || {}).rotation_matrix,
        rotation: r.viewerState.rotation.map((row) => row.map(
            (v) => Math.round(v * 1000) / 1000)),
      };
      R.orient.identity = [0, 1, 2].every((i) => [0, 1, 2].every((j) =>
          Math.abs(R.orient.rotation[i][j] - (i === j ? 1 : 0)) < 1e-6));

      // ...AND THE READER CAN ASK FOR IT AGAIN. The notebook had no Orient
      // control at all: the website's is in index.html, the embed had grown
      // its own in parts/embed.js, and this page - the one a notebook cell
      // actually shows - had neither. Wired in parts/ui.js now, from the same
      // markup both shells carry.
      const ob = document.querySelector('#orientButton');
      R.orientButton = !!ob;
      if (ob) {
        r.viewerState.rotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        r.render('probe');
        await settle();
        ob.click();
        await until(() => JSON.stringify(r.viewerState.rotation)
            !== JSON.stringify([[1, 0, 0], [0, 1, 0], [0, 0, 1]]), 4000);
        R.orientMoved = JSON.stringify(r.viewerState.rotation)
            !== JSON.stringify([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
      }

      // ...AND DRAW IS NOT OFFERED, because this build has no 2D painter to
      // honour it. Its neighbours in the same row must survive: needs2d drops
      // the ITEM, and dropping the row would take Smooth and Dark with it.
      R.painter = { has2d: !!window.py2dmolCartoonPaint,
                    hasGPU: !!window.py2dmolCartoonGPU };
      R.draw = !!document.querySelector('#drawCheckbox');
      R.drawNeighbours = ['#smoothCheckbox', '#arrowsCheckbox', '#darkCheckbox',
                          '#colorblindCheckbox']
          .filter((q) => document.querySelector(q)).length;

      // RMSD of each frame against frame 0, off the stored coordinates. The
      // asked-for object must be superposed and the other must not.
      const rmsds = (name) => {
        const fs = (r.objectsData[name] || {}).frames || [];
        if (!fs.length) return null;
        const f0 = fs[0].coords;
        return fs.map((f) => {
          let s = 0;
          for (let i = 0; i < f0.length; i++) {
            const a = f.coords[i]; const b = f0[i];
            s += (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
          }
          return +Math.sqrt(s / f0.length).toFixed(2);
        });
      };
      R.alignSpun = rmsds('spun');
      R.alignUnspun = rmsds('unspun');
      R.alignFlags = ((r.objectsData['spun'] || {}).frames || [])
          .map((f) => f.align === true);

      // THE PER-ATOM COLUMNS, which the static loader was dropping. It
      // rebuilds each frame field by field and never named these two, so
      // hasElementsFor() answered false on every notebook and element
      // colouring - which is ON by default - was dead there while working on
      // the website. The atom named CA with element CA is the point of having
      // both: in a protein CA is the alpha carbon, and here it is calcium.
      const wasOn = r.currentObjectName;
      r._switchToObject('lig');
      r.setFrame(0);
      await settle();
      const ligAll = new Set();
      for (let i = 0; i < r.coords.length; i++) ligAll.add(i);
      R.elements = {
        n: r.coords.length,
        els: (r.positionElements || []).slice(0, 4),
        has: r.hasElementsFor ? r.hasElementsFor(ligAll) : null,
        elementAt0: r.elementAt ? r.elementAt(0) : null,
      };
      // 🔴 AND THE SELECTION MARK FOLLOWS ITS BONDS, which on this path is
      // the whole question: viewer.py only ever sends bonds a caller supplied
      // by hand, so an ordinary ligand arrives with NONE and the renderer
      // derives them by distance for the sticks. The mark used to read the
      // file's list instead of the drawn segments, found nothing, and drew
      // each atom as an isolated position - which is a zero-length segment
      // with a round cap, a ring around every atom. Four atoms in a line
      // 1.5 A apart: three bonds, six path points. The bug gives eight (a hair
      // per atom) and a chord length of nothing.
      r.setResidueSelection(ligAll);
      window.__haloPath = 1;
      r.render('ligmark');
      await settle();
      const LP = window.__haloPath || {};
      window.__haloPath = 0;
      R.ligMark = {pts: LP.pts || 0, chord: +(LP.chord || 0).toFixed(2),
                   bonds: r.bonds ? r.bonds.length : null,
                   segs: (r.segmentIndices || []).length};
      r.clearResidueSelection();

      // ...and BACK, or every check below measures a four-atom ligand
      r._switchToObject(wasOn);
      r.setFrame(0);
      await settle();

      // THE SLAB PYTHON ASKED FOR, and the button that also drives it.
      R.clip = { fn: typeof r.autoClip === 'function',
                 button: !!document.querySelector('#clipButton') };
      if (R.clip.fn) {
        R.clip.on = r.clipSlabOn();
        R.clip.thickness = R.clip.on
            ? Math.round((r.clipNear - r.clipFar) * 10) / 10 : null;
        R.clip.extent = Math.round(r.viewerState.extent);
        // ...what clipping to the WHOLE object would give, so "thinner than
        // the structure" is measured against the structure rather than a
        // number typed here
        const whole = r.clipSlabForSelection(positionsFor(r, {object: 'spun'}));
        R.clip.wholeThickness = whole
            ? Math.round((whole.near - whole.far) * 10) / 10 : null;
        const cb = document.querySelector('#clipButton');
        if (cb) {
          R.clip.pressed = cb.getAttribute('aria-pressed');
          cb.click(); await settle();
          R.clip.afterClick = r.clipSlabOn();
          R.clip.pressedAfter = cb.getAttribute('aria-pressed');
        }
      }

      // ...AND WITHOUT ELEMENTS IT STILL DRAWS. No table can be consulted,
      // so every pair takes the flat cutoff - the behaviour there was before
      // the table existed, and the common case for raw coordinates.
      {
        const was = r.currentObjectName;
        r._switchToObject('noel'); r.setFrame(0);
        await settle();
        const segs = (r.segmentIndices || []).filter((sg) => sg && sg.type !== 'C');
        R.noel = {
          els: (r.positionElements || []).slice(0, 4),
          pairs: segs.filter((sg) => sg.idx1 !== sg.idx2)
            .map((sg) => [sg.idx1, sg.idx2].sort((a, b) => a - b).join('-')).sort(),
          lone: segs.filter((sg) => sg.idx1 === sg.idx2).length,
          colour: r.getAtomColor ? r.getAtomColor(0, 'auto') : null,
        };
        r._switchToObject(was); r.setFrame(0);
        await settle();
      }

      // BONDS BY ELEMENT, NOT BY ONE NUMBER. src/io/bonds.js is the table
      // and the renderer's distance fallback reads it, which is the only
      // route a notebook has.
      {
        const was = r.currentObjectName;
        r._switchToObject('chem'); r.setFrame(0);
        await settle();
        const segs = (r.segmentIndices || []).filter((sg) => sg && sg.type !== 'C');
        // A LONE ATOM IS A SEGMENT TOO - zero length, drawn as a dot - so
        // the bonds are the ones joining two DIFFERENT positions, and the
        // lone ones are the other half of the answer: the O pair must come
        // out as two dots, not as a bond.
        R.chem = {
          els: (r.positionElements || []).slice(0, 4),
          pairs: segs.filter((sg) => sg.idx1 !== sg.idx2)
            .map((sg) => [sg.idx1, sg.idx2].sort((a, b) => a - b).join('-')).sort(),
          lone: segs.filter((sg) => sg.idx1 === sg.idx2)
            .map((sg) => sg.idx1).sort((a, b) => a - b),
        };
        r._switchToObject(was); r.setFrame(0);
        await settle();
      }

      // ...AND THE PAE ARRIVED AS BYTES. panels/heatmap.js keeps a Uint8Array at
      // 1/8 A; viewer.py now sends base64 of exactly those bytes instead of a
      // JSON list of the same numbers. Checked as VALUES, not as a length: an
      // undecoded base64 string still has a length, and sqrt of it is still a
      // number, so the panel would have drawn a square of nonsense and every
      // "is there a matrix" check would have passed.
      const pr = r.heatmapRenderer;
      R.pae = {has: !!pr};
      if (pr && pr.bytes) {
        const at = (i, j) => pr.bytes[i * pr.n + j];
        R.pae.n = pr.n;
        R.pae.len = pr.bytes.length;
        R.pae.type = pr.bytes.constructor.name;
        R.pae.samples = [at(0, 0), at(0, 1), at(1, 0), at(3, 5), at(20, 20)];
      }

      // ...AND THE RESAMPLED ONE, which is where the two numbers separate.
      {
        const was2 = r.currentObjectName;
        r._switchToObject('big'); r.setFrame(0);
        window.Heatmap.syncToDrawn(r);
        await settle();
        const p2 = r.heatmapRenderer;
        R.bigPae = {n: p2.n, residues: p2.residues, len: p2.bytes
            ? p2.bytes.length : -1};
        if (p2.bytes) {
          // THE WHOLE STRUCTURE IS REACHABLE. Dragging the full plot must give
          // back every residue - an off-by-one in the scaling loses the tail,
          // and the plot still looks right.
          R.bigPae.full = p2.cellsToResidues(0, p2.n - 1, 0, p2.n - 1);
          R.bigPae.firstCell = p2.cellsToResidues(0, 0, 0, 0);
          R.bigPae.cellOfFirst = p2.residueToCell(0);
          R.bigPae.cellOfLast = p2.residueToCell(359);
          R.bigPae.corner = [p2.bytes[0],
                             p2.bytes[p2.n * p2.n - 1]];
          // 🔴 AND THE RECTANGLE LANDS WHERE IT WAS DRAGGED. A stored box is
          // in RESIDUES; the mask is laid out per CELL. They are the same
          // numbers only while the matrix is one cell per residue, so on a
          // resampled one the highlight came out at the wrong place and the
          // wrong size - a selection that lights a different region from the
          // one dragged.
          //
          // MEASURED ON THE CANVAS, not from the numbers: the bug is that the
          // drawing uses the wrong space, and every arithmetic check would
          // agree with it. Two renders, one with no box and one with a box
          // over residues 0..119 (= cells 0..99 of 300), and the pixels that
          // did NOT change are the region left bright - the box itself.
          const cv = r.heatmapRenderer.canvas;
          const snap = () => {
            r.heatmapRenderer.cachedSequencePositions = null;
            r.heatmapRenderer.render();
            return cv.getContext('2d')
                .getImageData(0, 0, cv.width, cv.height).data;
          };
          r.setVisibility({heatmapBoxes: [], positions: new Set(),
                           chains: new Set(), visibilityMode: 'default'}, true);
          const plainPx = snap();
          r.setVisibility({heatmapBoxes: [{i_start: 0, i_end: 119,
                                       j_start: 0, j_end: 119}],
                           positions: new Set(), chains: new Set(),
                           visibilityMode: 'explicit'}, true);
          const boxedPx = snap();
          let x1 = 1e9, y1 = 1e9, x2 = -1, y2 = -1;
          for (let y = 0; y < cv.height; y++) {
            for (let x = 0; x < cv.width; x++) {
              const i = (y * cv.width + x) * 4;
              if (plainPx[i] === boxedPx[i] && plainPx[i + 1] === boxedPx[i + 1]
                  && plainPx[i + 2] === boxedPx[i + 2]) {
                if (x < x1) x1 = x; if (x > x2) x2 = x;
                if (y < y1) y1 = y; if (y > y2) y2 = y;
              }
            }
          }
          R.bigPae.bright = [x1, y1, x2, y2];
          // ...AND THE OUTLINE, which is a SECOND drawing from the same
          // stored box and was the one that stayed in residues. The mask
          // above was converted and correct; `_drawSelectionBoxes`
          // multiplied residue indices by a cell size, so the black
          // rectangle sat outside the region it was framing. Only the
          // stroke makes a pixel DARKER - the overlay lightens everything
          // it covers - so the darkened pixels are the outline and nothing
          // else.
          let ox1 = 1e9, oy1 = 1e9, ox2 = -1, oy2 = -1, on = 0;
          for (let y = 0; y < cv.height; y++) {
            for (let x = 0; x < cv.width; x++) {
              const i = (y * cv.width + x) * 4;
              const d = (plainPx[i] - boxedPx[i]) + (plainPx[i + 1] - boxedPx[i + 1])
                      + (plainPx[i + 2] - boxedPx[i + 2]);
              if (d > 120) {
                on++;
                if (x < ox1) ox1 = x; if (x > ox2) ox2 = x;
                if (y < oy1) oy1 = y; if (y > oy2) oy2 = y;
              }
            }
          }
          R.bigPae.outline = [ox1, oy1, ox2, oy2];
          // ...AND THE CHAIN LINE, ruled from the same two spaces. A full
          // height stroke is a spike against its own neighbours, which a
          // gradient is not - so no second render is needed to find it.
          const dark = new Float64Array(cv.width);
          for (let x = 0; x < cv.width; x++) {
            let sum = 0;
            for (let y = 0; y < cv.height; y++) {
              const i = (y * cv.width + x) * 4;
              sum += 765 - plainPx[i] - plainPx[i + 1] - plainPx[i + 2];
            }
            dark[x] = sum;
          }
          let best = -1, bestScore = 0;
          for (let x = 6; x < cv.width - 6; x++) {
            const sc = dark[x] - (dark[x - 5] + dark[x + 5]) / 2;
            if (sc > bestScore) { bestScore = sc; best = x; }
          }
          R.bigPae.chainLine = best;
          R.bigPae.outlinePx = on;
          R.bigPae.canvas = cv.width;
          R.bigPae.cells = p2.n;
          r.setVisibility({heatmapBoxes: [], positions: new Set(),
                           chains: new Set(), visibilityMode: 'default'}, true);
        }
        r._switchToObject(was2); r.setFrame(0);
        window.Heatmap.syncToDrawn(r);
        await settle();
      }

      // FOCUS FALLS BACK WHERE THERE IS NO SIDE-CHAIN TABLE. It measures
      // side chain to side chain, because counting the CA drags in the
      // sequence neighbours and the residue across a sheet - but a CA trace
      // (and every notebook payload, which carries one position per residue)
      // has no side chains at all, and side-chain-only would then measure
      // NOTHING and answer with the seed alone.
      R.focusFallback = {table: !!r.sidechains};
      if (typeof r.focusOn === 'function') {
        const got = r.focusOn({positions: [20]});
        R.focusFallback.picked = got ? got.size : -1;
        r.clearFocus();
        await until(() => !r._focusAnim, 3000);
        await settle();
      }

      // A BUTTON THAT OPENS A PANEL HAS TO LOOK OPEN, and there are two
      // spellings of that state: Clip latches (aria-pressed) and Style and
      // Capture open a panel (aria-expanded). The open cue in this shell was
      // written as `#styleToggle[aria-expanded="true"]` - one button by name -
      // so Capture put its panel up with its own button unlit, and nothing on
      // screen said which of the two panels you had. index.html keys the same
      // rule on the state rather than the id, which is why the website was
      // right and this shell was not.
      //
      // MEASURED AS A COLOUR, not as the attribute: the attribute was already
      // being set and the button still looked off, so reading it back would
      // have passed against exactly the bug reported.
      const skin = (el) => getComputedStyle(el).backgroundColor;
      const capture = document.querySelector('#saveImageButton');
      const styleBtn = document.querySelector('#styleToggle');
      R.cue = {has: !!capture};
      if (capture) {
        R.cue.closed = skin(capture);
        capture.click(); await settle();
        R.cue.expanded = capture.getAttribute('aria-expanded');
        R.cue.open = skin(capture);
        capture.click(); await settle();
        R.cue.reclosed = skin(capture);
        // ...and Style, which is the control this was already right for -
        // if the two do not match, the skin is not shared and one of them
        // will drift.
        if (styleBtn) {
          styleBtn.click(); await settle();
          R.cue.styleOpen = skin(styleBtn);
          styleBtn.click(); await settle();
        }
      }

      R.tube = await look('tube');

      // 🔴 THE SHADOW SURVIVES AN SVG EXPORT WITH THE GPU ON. The CPU
      // occlusion pass is skipped when the GPU is going to draw, because the
      // GPU computes its own - and the question was asked of the RENDERER'S
      // STATE rather than of the context. An SVG context is one the GPU
      // refuses, so the export took the 2D path with a pass that had been
      // skipped on its behalf: gpu + tube + svg came out flat.
      //
      // Two exports, shadows on and off. They have to DIFFER - identical is
      // the bug, and it is what a "does it export at all" check cannot see -
      // and the shaded one has to be DARKER, which an inverted or misapplied
      // shadow would fail while still differing.
      // 🔴 AND THE PICTURE CAN BE TAKEN WITHOUT A DOWNLOAD. saveImage ends
      // in the browser's download flow, which is fine for one file and
      // useless for a thousand - reported by a reader wanting to render a
      // thousand structures from a script. toImage RETURNS the bytes, and
      // both sit on ONE renderer, so the dpi clamp, the export pixel scale
      // and the SVG refusals cannot drift between them.
      try {
        const a96 = await r.toImage({ format: 'png', dpi: 96 });
        const a300 = await r.toImage({ format: 'png', dpi: 300 });
        const asvg = await r.toImage({ format: 'svg' });
        const url = await r.toImage({ format: 'png', dpi: 96, dataUrl: true });
        R.toImage = {
          png: [a96.width, a96.height, a96.blob.size, a96.blob.type],
          hi: [a300.width, a300.height, a300.blob.size],
          svgLen: (asvg.text || '').length,
          svgHead: (asvg.text || '').slice(0, 4),
          svgPaths: ((asvg.text || '').match(/<path/g) || []).length,
          dataUrl: (url.dataUrl || '').slice(0, 22),
        };
      } catch (e) { R.toImage = { threw: String(e && e.message || e) }; }

      // 🔴 THE PAPER, AND THE CANVAS IT IS PAINTED ONTO. The export forced
      // transparency, so `transparent: false` could not be asked for at all -
      // and the fill under it read the SCREEN canvas's size while an export
      // renders into a DIFFERENT one (a 300 dpi PNG is 3.1x as wide), so asked
      // for paper it covered the top-left corner and cut out the rest.
      // ON THE 2D PAINTER, which is the only place it shows: the GPU clears
      // its own buffer at alpha 1 and blits the whole image over the fill.
      try {
        const wasGpu = r.useGPU, wasT = r.isTransparent, wasBg = r.backgroundColor;
        r.useGPU = false; r.isTransparent = false; r.backgroundColor = '#ffffff';
        const k = 2.5;
        const big = document.createElement('canvas');
        big.width = Math.round(r.displayWidth * k);
        big.height = Math.round(r.displayHeight * k);
        const bctx = big.getContext('2d');
        r._exportPxScale = k;
        try { r._renderToContext(bctx, big.width, big.height); }
        finally { r._exportPxScale = 1; }
        const d = bctx.getImageData(0, 0, big.width, big.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
        R.paper = { painted, px: big.width * big.height,
                    w: big.width, screen: r.canvas.width };
        r.useGPU = wasGpu; r.isTransparent = wasT; r.backgroundColor = wasBg;
        r.render('paperProbe');
      } catch (e) { R.paper = { threw: String(e && e.message || e) }; }

      if (typeof C2S !== 'undefined') {
        const svgOf = (on) => {
          r.shadowEnabled = on;
          r.render('svgProbe');
          const c = new C2S(300, 300);
          r._renderToContext(c, 300, 300);
          return c.getSerializedSvg();
        };
        // HOW MANY DIFFERENT COLOURS, not how dark. Occlusion carries a TINT
        // as well as a shade - see _shadowPairExcluded - so the mean can move
        // either way on a given structure, and it does on this one. What the
        // pass always does is give each segment its OWN value: with it off the
        // strokes collapse onto the flat palette.
        const shades = (svg) =>
            new Set(svg.match(/stroke="#[0-9a-f]{6}"/g) || []).size;
        // ...AND THE SCREEN PATH IS UNTOUCHED. The guard only fires on a
        // context the GPU would refuse anyway; a real canvas context still
        // answers "the GPU will draw", so the occlusion pass is still skipped
        // on screen. That pass is ~90% of a tube frame on a large structure,
        // so turning it back on for every frame would be the wrong trade.
        const onScreen = r._gpuWillDraw(r.canvas.getContext('2d'));
        const onExport = r._gpuWillDraw(new C2S(50, 50));
        const withS = svgOf(true), without = svgOf(false);
        R.svgShadow = {
          gateScreen: onScreen, gateExport: onExport,
          gpu: !!r.useGPU,
          gpuAvailable: !!(window.py2dmolCartoonGPU
              && window.py2dmolCartoonGPU.available
              && window.py2dmolCartoonGPU.available()),
          strokes: (withS.match(/stroke="/g) || []).length,
          differ: withS !== without,
          shadesOn: shades(withS), shadesOff: shades(without),
        };
        r.shadowEnabled = true;
        r.render('svgProbe');
      }
      R.cartoon = await look('cartoon');

      // WHAT IS ABSENT STAYS ABSENT rather than being invented
      R.absent = {
        sidechainTable: !r.sidechains,
        sidechainOwners: (r.sidechainOwners && r.sidechainOwners())
          ? r.sidechainOwners().size : 0,
        hasSidechainsFor: r.hasSidechainsFor ? r.hasSidechainsFor(all) : null,
        hasElementsFor: r.hasElementsFor ? r.hasElementsFor(all) : null,
        hasBasesFor: r.hasBasesFor ? r.hasBasesFor(all) : null,
        // every position is protein by default, so SSE is offered
        hasSseFor: r.hasSseFor ? r.hasSseFor(all) : null,
        names: (r.positionNames || []).slice(0, 3),
        chains: [...new Set(r.chains || [])],
        types: [...new Set(r.positionTypes || [])],
        nTypes: (r.positionTypes || []).length,
      };
      // ...and the things the panel does, on a structure with none of that
      r.residueSelection = new Set([1, 2, 3]);
      R.after = {
        forced: r.forcedSseFor([1, 2, 3]),
        assigned: r.assignedSseFor([Math.floor(r.coords.length * 0.25)]),
        framing: r.framingPositions ? r.framingPositions(new Set([1, 2])).size : -1,
        within: r.residuesWithin ? r.residuesWithin([1], 8, {}).length : -1,
        pickable: r._pickable ? r._pickable(1) : null,
      };
    } catch (e) { R.errors.push(String((e && e.stack) || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)

# A CA TRACE AND NOTHING ELSE - three turns of an alpha helix followed by a
# strand, so the assignment has something to find.
def trace():
    pts = []
    for i in range(40):
        t = i * 100.0 * np.pi / 180.0
        pts.append([2.3 * np.cos(t), 2.3 * np.sin(t), 1.5 * i])
    for i in range(20):
        pts.append([12.0 + 3.3 * i, 4.0 * (i % 2), 60.0])
    return np.array(pts, dtype=float)


def main():
    v = py2Dmol.view(style='cartoon', pae=True)
    # A PAE, AS THE BIGGEST THING A PAYLOAD EVER CARRIES. It is N^2, and on the
    # demo notebook one 837x837 matrix was 72% of the file - so it travels
    # base64 now rather than as a JSON list of a million numbers. That is a
    # change of WIRE FORMAT with a decoder on the other side, which is exactly
    # the kind of thing that fails silently: an undecoded string has a length,
    # so the panel would take sqrt of it and draw a plausible square of
    # nonsense. Synthetic and asymmetric on purpose - value = i + 2*j clipped -
    # so a transpose, an off-by-one row and a reversed array are all visible.
    _n = len(trace())
    _pae = np.minimum(np.add.outer(np.arange(_n), 2 * np.arange(_n)), 31.0)
    v.add(trace(), pae=_pae)
    # ...AND THE SAME TRACE TURNED 90 DEGREES, as a second frame of a second
    # object. align=True is the default and the browser does the fitting now,
    # so what a payload carries is the REQUEST - and this page is the static
    # path, which is where it was being dropped. A third frame turned again,
    # because a single pair cannot tell "aligned" from "the second frame was
    # already there". `spun` asks for it; `unspun` says align=False and must
    # come back exactly as it was written.
    _t = trace()
    _R = np.array([[0., -1., 0.], [1., 0., 0.], [0., 0., 1.]])
    for name, want in (('spun', True), ('unspun', False)):
        v.add(_t, name=name, align=want)
        v.add(_t @ _R.T, name=name, align=want)
        v.add(_t @ _R.T @ _R.T, name=name, align=want)
    # ...AND A SLAB, asked for from PYTHON. parts/clip.js is in every bundle -
    # the notebook has always carried the code - and until now nothing in
    # Python or in this page could reach it. Three residues of a 60-residue
    # trace, so the slab must come out markedly thinner than the structure's
    # own depth; clipping to all 60 is the control, because a slab that is
    # simply the whole extent would pass a "there is a slab" check.
    # ...AND A LIGAND, whose atoms carry an element each. These are the two
    # per-atom columns, and they are the ONLY reason element colouring can
    # work: a backbone position stands for a whole residue and has neither.
    # Built here rather than loaded, because the .cif files are not in the
    # repo - and this is the public API, which is what the transport is for.
    # ...AND ONE BIGGER THAN THE PANEL CAN DRAW. Above `pae.size` cells the
    # browser was throwing the detail away on every frame anyway, so viewer.py
    # resamples once - and that makes the matrix side and the RESIDUE COUNT two
    # different numbers, where the panel had been using one for both. A box
    # dragged on the plot is a range of residues handed to setVisibility, so
    # getting the scaling wrong selects the wrong part of the structure while
    # looking perfectly plausible.
    _big = 360
    _bigpae = np.minimum(np.add.outer(np.arange(_big), 2 * np.arange(_big)), 31.0)
    # TWO CHAINS, so the panel's boundary line has somewhere to be wrong: it
    # is ruled at a residue index on a canvas laid out in cells, the same
    # crossing as the selection box.
    _bigsplit = 200
    v.add(np.stack([np.arange(_big) * 1.5, np.zeros(_big), np.zeros(_big)], 1),
          name='big', pae=_bigpae,
          chains=['A'] * _bigsplit + ['B'] * (_big - _bigsplit))

    _lig = np.array([[0., 0., 0.], [1.5, 0., 0.], [3.0, 0., 0.], [4.5, 0., 0.]])
    v.add(_lig, name='lig',
          position_types=['L'] * 4,
          position_elements=['CA', 'C', 'N', 'O'])

    # ...AND A LIGAND WHERE THE FLAT CUTOFF AND THE ELEMENT TABLE DISAGREE,
    # in both directions at once. A notebook derives its ligand bonds in the
    # renderer - viewer.py forwards only bonds a caller supplied by hand - and
    # that used one number, 2.0 A, for every pair of elements:
    #   S-S at 2.05  a disulfide, MISSED by the flat rule (table says 2.4)
    #   O-O at 1.90  not a bond,  DRAWN by the flat rule (table says 1.7)
    # Far enough apart that nothing else is a candidate.
    v.add(np.array([[0., 0., 0.], [2.05, 0., 0.], [0., 6., 0.], [1.9, 6., 0.]]),
          name='chem', position_types=['L'] * 4,
          position_elements=['S', 'S', 'O', 'O'])

    # ...AND THE SAME LIGAND WITH NO ELEMENTS AT ALL, which is what handing
    # raw coordinates to add() gives you. The table cannot be consulted, so
    # every pair falls back to the flat cutoff and the picture is what it was
    # before there was a table: four atoms 1.5 A apart, three bonds.
    v.add(np.array([[0., 0., 0.], [1.5, 0., 0.], [3.0, 0., 0.], [4.5, 0., 0.]]),
          name='noel', position_types=['L'] * 4)

    v.clip(name='spun', position=(0, 3))
    body = v._display_viewer(static_data=v.objects)
    assert v.config.get('clip') == {'object': 'spun', 'positions': [0, 1, 2]}, \
        f"viewer.py did not put the selector in the config: {v.config.get('clip')}"
    open(PROBE, 'w').write('<!doctype html><html><head><meta charset="utf-8">'
                           '</head><body>' + body + JS + '</body></html>')
    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a): pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
            self.send_response(200); self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9715), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=/tmp/py2dmol-min',
                          '--no-first-run', '--window-size=900,900',
                          'http://127.0.0.1:9715/_minimal.html'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end:
        time.sleep(0.5)
    p.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree('/tmp/py2dmol-min', ignore_errors=True)
    R = box[0] if box else {'errors': ['no result posted']}

    for style in ('tube', 'cartoon'):
        s = R.get(style) or {}
        print(f"  {style:8s} {s.get('n')} positions, {s.get('ink')} ink,"
              f" SSE {s.get('sse')!r} {s.get('tally')}; {s.get('coldMs')}ms cold,"
              f" {s.get('warmMs')}ms warm, {s.get('allMs')}ms over all of it")
    print(f"  absent: {R.get('absent')}")
    print(f"  align: flags {R.get('alignFlags')}, asked-for {R.get('alignSpun')},"
          f" refused {R.get('alignUnspun')}")
    print(f"  clip:  {R.get('clip')}")
    print(f"  elements: {R.get('elements')}")
    print(f"  orient button {R.get('orientButton')}, moved the camera"
          f" {R.get('orientMoved')}; painter {R.get('painter')},"
          f" Draw offered {R.get('draw')}, {R.get('drawNeighbours')}/4 neighbours")
    print(f"  panel:  {R.get('after')}")
    o = R.get('orient') or {}
    print(f"  orient: module {o.get('module')}, from python"
          f" {o.get('fromPython')}, identity {o.get('identity')}")

    pa = R.get('paper') or {}
    print(f"  paper: {pa.get('painted')} of {pa.get('px')} painted on a"
          f" {pa.get('w')}px export (screen {pa.get('screen')}px)")

    ti = R.get('toImage') or {}
    print(f"  toImage: png {ti.get('png')}, 300dpi {ti.get('hi')},"
          f" svg {ti.get('svgLen')} chars / {ti.get('svgPaths')} paths")

    bad = []
    if pa.get('threw'):
        bad.append('the paper probe threw: ' + pa['threw'])
    elif pa.get('painted') != pa.get('px'):
        bad.append(f"transparent:false painted {pa.get('painted')} of"
                   f" {pa.get('px')} pixels - the background fill is reading"
                   f" the screen canvas's size, not the export's")
    # 🔴 A SCRIPT NEEDS THE BYTES, NOT A DOWNLOAD. saveImage ends in the
    # browser's download flow; toImage is the door that returns them.
    if ti.get('threw'):
        bad.append(f"toImage threw: {ti.get('threw')} - a script then has no"
                   " way at all to get a picture out")
    else:
        png = ti.get('png') or [0, 0, 0, '']
        hi = ti.get('hi') or [0, 0, 0]
        if png[3] != 'image/png' or png[2] < 1000:
            bad.append(f"toImage(png) gave {png}, which is not a PNG")
        # 300 dpi is 96 dpi times 300/96, and the BYTES have to grow with the
        # pixels - a scale that reached the canvas size but not the drawing
        # would keep the dimensions and lose the detail.
        if not (hi[0] > png[0] * 2.5 and hi[2] > png[2]):
            bad.append(f"300 dpi gave {hi} against 96 dpi's {png} - the dpi"
                       " reached the canvas size but not the drawing")
        if ti.get('svgHead') != '<svg' or (ti.get('svgPaths') or 0) < 50:
            bad.append(f"toImage(svg) returned {ti.get('svgLen')} chars, head"
                       f" {ti.get('svgHead')!r}, {ti.get('svgPaths')} paths -"
                       " an export with no paths is 359 bytes of nothing,"
                       " which every length check passes")
        if ti.get('dataUrl') != 'data:image/png;base64,':
            bad.append(f"dataUrl came back as {ti.get('dataUrl')!r}")

    o = R.get('orient') or {}
    if not o.get('module'):
        bad.append('parts/orient.js is not in the notebook bundle, so nothing can'
                   ' choose a viewing angle now that viewer.py does not')
    if o.get('fromPython'):
        bad.append('the payload still carries a rotation_matrix from Python -'
                   ' best_view was meant to go with numeric.js')
    if o.get('identity'):
        bad.append('the viewer opened at the identity rotation: nothing oriented it,'
                   ' so the structure faces whichever way the file happened to be')
    for e in R.get('errors', []):
        bad.append('page error: ' + e)
    for style in ('tube', 'cartoon'):
        s = R.get(style) or {}
        if not s.get('ink'):
            bad.append(f'{style} drew nothing from a bare CA trace')
        if s.get('sse') not in ('H', 'E', 'C'):
            bad.append(f"{style}: the assignment answered {s.get('sse')!r} for one"
                       " residue of a CA trace - predictBackbone is what makes"
                       " that possible")
        tally = s.get('tally') or {}
        if tally.get('H', 0) < 5:
            bad.append(f"a 40-residue helix drawn as a CA trace was assigned"
                       f" {tally} - the trace carries the structure and the"
                       " assignment should find it")
        # THE PANEL ASKS ON EVERY CLICK, so a warm ask has to be free
        if s.get('warmMs', 99) > 1.0:
            bad.append(f"{style}: asking again costs {s.get('warmMs')}ms - the"
                       " panel asks on every selection change")
    ff = R.get('focusFallback') or {}
    print(f"  focus with no side-chain table: {ff}")
    if ff.get('table'):
        bad.append('this fixture grew a side-chain table, so it no longer'
                   ' measures the fallback it is here for')
    elif not (ff.get('picked', 0) > 1):
        bad.append(f"focus picked {ff.get('picked')} positions on a CA trace -"
                   ' it measures side chain to side chain, and with no table'
                   ' that is nothing at all, so it has to fall back to the'
                   ' trace or answer with the seed alone')

    sv = R.get('svgShadow') or {}
    print(f"  svg shadow (gpu tube): {sv}")
    if not sv:
        bad.append('no SVG was built - core/svg.js is in the notebook bundle'
                   ' and the tube exports a vector on every build')
    elif not sv.get('gpuAvailable'):
        bad.append('no WebGL2 in this browser, so gpu+tube+svg is untested'
                   ' here and this check proves nothing')
    elif not sv.get('strokes'):
        bad.append('the tube exported an SVG with no strokes in it')
    elif not sv.get('differ'):
        bad.append('the SVG is byte-identical with shadows on and off - the'
                   ' CPU occlusion pass is skipped when the GPU is going to'
                   ' draw, and an export context is one the GPU refuses, so'
                   ' asking that question of the state rather than of the'
                   ' context loses the shadow')
    elif not sv.get('gateScreen') or sv.get('gateExport'):
        bad.append(f"the GPU gate answers {sv.get('gateScreen')} for the screen"
                   f" and {sv.get('gateExport')} for an export - it has to be"
                   ' true then false, or either the shadow is lost on export'
                   ' or the occlusion pass runs on every screen frame, which'
                   ' is ~90% of a tube frame')
    elif not (sv.get('shadesOn', 0) > sv.get('shadesOff', 0)):
        bad.append(f"the shaded SVG uses {sv.get('shadesOn')} stroke colours"
                   f" against {sv.get('shadesOff')} unshaded - the pass gives"
                   ' each segment its own value, so it differs but is not'
                   ' shading')

    bp = R.get('bigPae') or {}
    if bp.get('outline'):
        cells, cw = bp.get('cells'), bp.get('canvas')
        # residues 0..119 of 360, drawn on a 300-cell matrix -> cells 0..99,
        # so the outline's far edge is at 100/300 of the canvas. The bug puts
        # it at 120/300 - the residue index used as a cell one.
        want = round(100 * cw / cells)
        ox1, oy1, ox2, oy2 = bp['outline']
        print(f"  pae outline: {bp['outline']} ({bp.get('outlinePx')} px),"
              f" far edge wanted ~{want} on a {cw}px canvas of {cells} cells")
        if not bp.get('outlinePx'):
            bad.append('the selection box drew no outline at all, so this leg'
                       ' is measuring nothing')
        elif ox1 > 3 or oy1 > 3:
            bad.append(f"the outline starts at ({ox1}, {oy1}) for a box at"
                       " residue 0 - it should touch the corner")
        elif abs(ox2 - want) > 4 or abs(oy2 - want) > 4:
            bad.append(f"the selection outline ends at ({ox2}, {oy2}), wanted"
                       f" ~{want}: a stored box is in RESIDUES and this canvas"
                       " is laid out in CELLS. The mask above is converted and"
                       " the outline was not, so the black rectangle frames a"
                       " different region from the one it highlights")

    if bp.get('chainLine') is not None:
        cells, cw = bp['cells'], bp['canvas']
        wantc = round(round(200 * cells / 360) * cw / cells)
        print(f"  pae chain line: x={bp['chainLine']}, wanted ~{wantc}")
        if abs(bp['chainLine'] - wantc) > 4:
            bad.append(f"the chain boundary is ruled at x={bp['chainLine']},"
                       f" wanted ~{wantc}: residue {200} of 360 is cell"
                       f" {round(200 * cells / 360)} of {cells}. The walk is"
                       " over residues and the line is drawn in cells")

    noel = R.get('noel') or {}
    print(f"  no elements: {noel.get('els')} -> bonds {noel.get('pairs')},"
          f" {noel.get('lone')} lone, colour {noel.get('colour')}")
    if any(noel.get('els') or []):
        bad.append(f"the no-element fixture arrived with {noel.get('els')} -"
                   " it exists to test the path where there are none")
    elif noel.get('pairs') != ['0-1', '1-2', '2-3'] or noel.get('lone'):
        bad.append(f"a ligand with NO elements bonded as {noel.get('pairs')}"
                   f" with {noel.get('lone')} lone atoms, wanted the three"
                   " bonds of four atoms 1.5 A apart. Without elements every"
                   " pair takes the flat cutoff, which is what there was"
                   " before the table")
    elif not noel.get('colour'):
        bad.append('an atom with no element got no colour at all')

    chem = R.get('chem') or {}
    print(f"  bond table: elements {chem.get('els')} -> bonds"
          f" {chem.get('pairs')}, lone atoms {chem.get('lone')}")
    if chem.get('els') != ['S', 'S', 'O', 'O']:
        bad.append(f"the elements arrived as {chem.get('els')} - without them"
                   " the table cannot be consulted and this leg proves nothing")
    elif chem.get('pairs') != ['0-1'] or chem.get('lone') != [2, 3]:
        bad.append(f"the ligand bonded as {chem.get('pairs')} with lone atoms"
                   f" {chem.get('lone')}, wanted ['0-1'] and [2, 3]. S-S at"
                   " 2.05 A is a disulfide the flat 2.0 cutoff misses, and O-O"
                   " at 1.9 A is not a bond the flat cutoff draws anyway."
                   " src/io/bonds.js is the table both the parser and the"
                   " renderer read")

    pae = R.get('pae') or {}
    print(f"  pae: {pae}")
    _n = 60
    # value = min(i + 2j, 31), stored as round(v * 8)
    want = [min(i + 2 * j, 31) * 8 for i, j in
            ((0, 0), (0, 1), (1, 0), (3, 5), (20, 20))]
    if not pae.get('has'):
        bad.append('no PAE panel on a viewer built with pae=True')
    elif pae.get('type') != 'Uint8Array':
        bad.append(f"the PAE arrived as {pae.get('type')} - viewer.py sends"
                   ' base64 and panels/heatmap.js decodes it into a Uint8Array')
    elif pae.get('n') != _n or pae.get('len') != _n * _n:
        bad.append(f"the PAE came out {pae.get('n')}x{pae.get('n')}"
                   f" ({pae.get('len')} values) for a {_n}-position trace -"
                   ' an undecoded base64 string has a length too, and sqrt of'
                   ' it is still a number')
    elif pae.get('samples') != want:
        bad.append(f"the PAE values are {pae.get('samples')}, wanted {want}"
                   ' - the matrix is asymmetric on purpose, so a transpose or'
                   ' a shifted row shows up here')

    bp = R.get('bigPae') or {}
    print(f"  resampled pae: {bp}")
    if bp.get('n') != 300 or bp.get('len') != 300 * 300:
        bad.append(f"a 360-row matrix came out {bp.get('n')} cells"
                   f" ({bp.get('len')} values) - the panel draws into a"
                   ' 300px canvas, so viewer.py resamples to that')
    elif bp.get('residues') != 360:
        bad.append(f"the resampled matrix says {bp.get('residues')} residues -"
                   ' pae_n travels beside it precisely so the panel can tell'
                   ' cells from residues')
    elif bp.get('full') != {'i_start': 0, 'i_end': 359,
                            'j_start': 0, 'j_end': 359}:
        bad.append(f"dragging the whole plot selects {bp.get('full')} of 360"
                   ' residues - a box is handed to setVisibility as positions,'
                   ' so this is the part that picks the wrong helix')
    elif bp.get('cellOfFirst') != 0 or bp.get('cellOfLast') != 299:
        bad.append(f"residue 0 and residue 359 draw in cells"
                   f" {bp.get('cellOfFirst')} and {bp.get('cellOfLast')} of 300")
    elif bp.get('bright') and bp.get('canvas'):
        # residues 0..119 of 360 are cells 0..99 of 300; the mask covers cells
        # 0..99 inclusive, so the bright block ends at 100 * canvas / 300.
        want = round(100 * bp['canvas'] / bp['cells'])
        got = bp['bright'][2] + 1
        # ...from the corner, give or take the panel's 1px inset
        if bp['bright'][0] > 2 or bp['bright'][1] > 2:
            bad.append(f"the highlight starts at {bp['bright'][:2]}, not the"
                       ' top-left corner the box was drawn in')
        elif abs(got - want) > 3:
            bad.append(f"a box over residues 0-119 lit {got}px of a"
                       f" {bp['canvas']}px plot, wanted about {want} - a stored"
                       ' box is in RESIDUES and the mask is laid out per CELL,'
                       ' so on a resampled matrix the highlight lands in the'
                       ' wrong place at the wrong size')
    elif bp.get('corner') != [0, 248]:
        bad.append(f"the resampled corners are {bp.get('corner')}, wanted"
                   ' [0, 248] - the matrix is 0 at the origin and saturated at'
                   ' the far corner whatever the resampling does')

    c = R.get('cue') or {}
    print(f"  capture cue: {c}")
    if not c.get('has'):
        bad.append('no Capture button in the notebook shell')
    elif c.get('expanded') != 'true':
        bad.append('opening the Save panel did not set aria-expanded on its'
                   ' button, so nothing can style it and nothing reading the'
                   ' page can tell the panel is open')
    elif c.get('open') == c.get('closed'):
        bad.append(f"the Capture button looks the same open as closed"
                   f" ({c.get('open')}) - the open cue was written for"
                   " #styleToggle by name, so Capture put its panel up unlit")
    elif c.get('reclosed') != c.get('closed'):
        bad.append(f"the Capture button stayed lit after its panel closed:"
                   f" {c.get('reclosed')} against {c.get('closed')}")
    elif c.get('styleOpen') != c.get('open'):
        bad.append(f"Style open is {c.get('styleOpen')} and Capture open is"
                   f" {c.get('open')} - two buttons in the same row wearing"
                   ' two different skins for the same state is how the'
                   ' by-name rule got there in the first place')

    a = R.get('absent') or {}
    if not a.get('sidechainTable'):
        bad.append('a side-chain table was invented for a structure with no atoms')
    spun = R.get('alignSpun') or []
    unspun = R.get('alignUnspun') or []
    if len(spun) != 3 or len(unspun) != 3:
        bad.append(f'the alignment fixture did not load: {spun} / {unspun}')
    else:
        if not all(f is True for f in (R.get('alignFlags') or [])):
            bad.append('the static payload carries no `align` on its frames -'
                       ' viewer.py builds a light frame field by field and a'
                       ' field it does not name is one it throws away')
        if max(spun) > 0.01:
            bad.append(f'align=True left the frames {spun} A apart - the'
                       ' browser does the fitting now, so a payload that drops'
                       ' the request draws every frame where its file put it')
        if max(unspun) < 1.0:
            bad.append(f'align=False came back {unspun} A apart, so this'
                       ' fixture cannot tell aligned from unaligned and the'
                       ' check above proves nothing')

    e = R.get('elements') or {}
    if e.get('els') != ['CA', 'C', 'N', 'O']:
        bad.append(f"the ligand's elements arrived as {e.get('els')} - the static"
                   ' loader rebuilds each frame field by field and a field it'
                   ' does not name is one it throws away, so element colouring'
                   ' was dead in every notebook')
    if not e.get('has'):
        bad.append('hasElementsFor says no on a ligand that carries elements')
    lm = R.get('ligMark') or {}
    print(f"  ligand mark: {lm.get('pts')} path points, chord {lm.get('chord')} px"
          f" (file bonds: {lm.get('bonds')}, segments: {lm.get('segs')})")
    if lm.get('bonds'):
        bad.append(f"the fixture supplied {lm['bonds']} bonds, so this leg is not"
                   " testing the path it exists for - a ligand with NO bond list")
    if lm.get('pts') != 6:
        bad.append(f"the mark on a four-atom ligand has {lm.get('pts')} path"
                   " points, not the 6 of three bonds - 8 means every atom was"
                   " drawn as an isolated position, which is a ring around each"
                   " one instead of a band along the bonds")
    if (lm.get('chord') or 0) < 1:
        bad.append(f"the mark spans {lm.get('chord')} px across a ligand 4.5 A"
                   " long - it is not following anything")
    if e.get('elementAt0') != 'CA':
        bad.append(f"elementAt(0) is {e.get('elementAt0')!r}, not the calcium the"
                   ' file names - which is why the element cannot simply be read'
                   ' off the atom name: CA is an alpha carbon everywhere else')

    c = R.get('clip') or {}
    if not c.get('fn'):
        bad.append('parts/clip.js is not in the notebook bundle, so nothing'
                   ' Python asks for can be honoured')
    if not c.get('button'):
        bad.append('the notebook page has no Clip control - the slab shipped in'
                   ' every bundle and only the website could reach it')
    elif not c.get('on'):
        bad.append('view.clip() from Python left no slab on the page - the'
                   ' request rides in the config, which normalizeConfig carries'
                   ' as an unknown top-level key, and ui.js applies AFTER the'
                   ' orientation because depth is measured along the view')
    elif not (c.get('thickness') < c.get('wholeThickness') - 1):
        bad.append(f"clipping to 3 of 60 residues gave {c.get('thickness')} A"
                   f" against {c.get('wholeThickness')} A for the whole object -"
                   ' the selector did not reach positionsFor, so the slab is'
                   ' just the structure')
    if c.get('pressed') != 'true':
        bad.append(f"the Clip button reads {c.get('pressed')!r} while a slab is"
                   ' on - it does not follow the slab, only its own clicks')
    if c.get('afterClick') is not False:
        bad.append('pressing Clip with a slab on did not clear it')
    if c.get('pressedAfter') != 'false':
        bad.append('the Clip button still reads pressed after clearing')

    if not R.get('orientButton'):
        bad.append('the notebook page has no Orient control - the website has one'
                   ' in index.html and the embed shell carries one, and this is'
                   ' the page a notebook cell actually shows')
    if not R.get('orientMoved'):
        bad.append('pressing Orient did not move the camera')
    # THE NOTEBOOK CARRIES BOTH PAINTERS NOW, so Draw is offered rather than
    # hidden. It used to be the other way round: one painter per bundle, and
    # the toggle had to go because _gpuWillTake returns false while drawMode is
    # on and there was nothing behind it. Sharing pays the library once
    # per document instead of once per cell, so the 26 KB the second painter
    # costs buys back Draw, cartoon SVG export, and a picture on a machine with
    # no WebGL2.
    if not (R.get('painter') or {}).get('has2d'):
        bad.append('the notebook bundle has no 2D painter - Draw and SVG export'
                   ' of the cartoon both need it, and it is 26 KB')
    if not R.get('draw'):
        bad.append('Draw is not offered even though the 2D painter is in the'
                   ' download - parts/panel.js drops the item on needs2d')
    if R.get('drawNeighbours') != 4:
        bad.append(f"only {R.get('drawNeighbours')} of Draw's 4 row neighbours"
                   ' survived - needs2d must drop the ITEM, not the row')
    if a.get('hasSidechainsFor') or a.get('hasElementsFor') or a.get('hasBasesFor'):
        bad.append(f'the panel offers rows it has no data for: {a}')
    if not a.get('hasSseFor'):
        bad.append('SSE is withheld from a protein trace')
    after = R.get('after') or {}
    if after.get('forced') != 'none':
        bad.append(f"an untouched trace reads as forced: {after.get('forced')}")
    if after.get('assigned') not in ('H', 'E', 'C'):
        bad.append(f"the panel gets {after.get('assigned')!r} for the assignment")
    if after.get('framing', 0) < 2:
        bad.append(f"framing a selection came back with {after.get('framing')}")
    for m in bad:
        print('FAIL:', m)
    sys.exit(1 if bad else 0)


main()
