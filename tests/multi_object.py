"""Two objects on screen at once, in a real browser.

    python3 tests/multi_object.py 1BBH.cif 1HVR.cif --png /tmp/multi.png

What it checks, once the merge is switched on with setShownObjects:

  - both objects' positions are in ONE coordinate array, and the source map
    covers every one of them;
  - no segment joins two objects - the failure that a merge invites and that
    nothing in the drawing would make obvious, since a bond across the gap
    between two structures looks like a long bond, not like a bug;
  - each object is drawn in a colour of its own;
  - the picture actually changes: ink counted with one object showing and with
    both, in ONE page load (the paper grain is re-seeded per load, so across
    loads a comparison measures the grain - see tests/README.md);
  - and the same again with the GPU path on, since a merged array is one
    structure as far as it is concerned and it should need no new code.

Same two traps as tests/gpu_bench.py: the page POSTs its result back rather
than being scraped, and every local script src is stamped per run.
"""
import argparse, base64, http.server, json, os, re, shutil, socketserver
import subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_multi_probe.html")

PAGE_JS = """
<script>
window.addEventListener('load', () => {
  const P = new URLSearchParams(location.search);
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  // ink: how many pixels are not the background, so "did the picture change"
  const renderObjectListIfAny = () => {
    const b = document.getElementById('objectListButton');
    if (b && document.getElementById('objectList').hidden) b.click();
  };
  const ink = (r) => {
    const c = r.canvas, x = c.getContext('2d');
    if (!x) return -1;
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) n++;
    }
    return n;
  };
  const go = async () => {
    const R = {};
    try {
      const gc = document.createElement('canvas').getContext('webgl2');
      const dbg = gc && gc.getExtension('WEBGL_debug_renderer_info');
      R.renderer = dbg ? gc.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?';
      await load(P.get('a'));
      await load(P.get('b'));
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      const names = Object.keys(r.objectsData);
      R.objects = names;

      // A PLAIN LOAD, BEFORE ANY API CALL. This is how a user gets here -
      // fetch one structure, fetch another - and the resting state is ONE
      // object on screen, the one the picker names, exactly as the viewer has
      // always behaved. Loading a second file does not change what you are
      // looking at, and does not merge anything.
      R.plainDrawn = r.drawnObjects();
      R.plainN = r.coords.length;
      R.plainMulti = !!(r.multiState && r.multiState.enabled);
      R.plainVisible = r.visiblePositions ? r.visiblePositions.size : r.coords.length;

      r.setShownObjects([names[0]]);
      r.render('one');
      await new Promise((s) => setTimeout(s, 200));
      R.oneInk = ink(r);
      R.oneN = r.coords.length;

      r.setShownObjects(names);
      r.render('both');
      await new Promise((s) => setTimeout(s, 200));
      R.bothInk = ink(r);
      if (P.get('png') === '1') R.pngCpu = r.canvas.toDataURL('image/png');
      R.bothN = r.coords.length;
      R.multi = !!(r.multiState && r.multiState.enabled);
      R.sources = r.multiState ? r.multiState.sourceNames : null;
      R.offsets = r.multiState ? r.multiState.sourceOffsets : null;

      // every position mapped, and no segment across the join
      const g = r.sourceGroups();
      R.mapLen = g ? g.length : -1;
      let crossing = 0;
      for (const s of r.segmentIndices) {
        if (s.idx2 === undefined || s.idx2 === s.idx1) continue;
        if (g[s.idx1] !== g[s.idx2]) crossing++;
      }
      R.crossing = crossing;
      R.segments = r.segmentIndices.length;
      R.autoColor = r.resolvedAutoColor;

      // one colour per object: sample the colour of a position from each
      const cols = {};
      for (let s = 0; s < R.sources.length; s++) {
        const at = R.offsets[s];
        const c = r.getAtomColor(at, r._getEffectiveColorMode());
        cols[R.sources[s]] = [c.r, c.g, c.b].join(',');
      }
      R.colors = cols;
      R.autos = r.multiState ? r.multiState.sourceAutoColors : null;
      // NO COLOUR SHARED ACROSS THE JOIN. Both structures have a chain A, and
      // under the chain scheme that came out the same colour for both - two
      // molecules reading as one. Sampled from the drawing, per source.
      const bySource = [new Set(), new Set()];
      for (let i = 0; i < r.coords.length; i++) {
        const src = g[i];
        if (src !== 0 && src !== 1) continue;
        const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
        bySource[src].add([c.r, c.g, c.b].join(','));
      }
      R.perSource = bySource.map((x) => Array.from(x));
      R.sharedColors = R.perSource[0].filter((c) => R.perSource[1].includes(c));
      R.modes = {global: r.colorMode, effective: r._getEffectiveColorMode(),
        perObject: r.objectsData[r.currentObjectName].colorMode,
        resolvedAuto: r.resolvedAutoColor};
      // what the DRAWING used: the distinct segment colours actually painted
      const sc = r._calculateSegmentColors();
      const tally = {};
      for (let i = 0; i < sc.length; i++) {
        const k = [sc[i].r, sc[i].g, sc[i].b].join(',');
        tally[k] = (tally[k] || 0) + 1;
      }
      R.painted = tally;

      // A PER-OBJECT SET, EDITED THROUGH THE MERGE. Hiding the second
      // object's backbone must land on the second object, in its own
      // numbering, and leave the first one alone and fully drawn.
      const off1 = R.offsets[1];
      const hide = [];
      for (let i = off1; i < r.coords.length && i < off1 + 40; i++) hide.push(i);
      r.setBackboneHiddenFor(hide, true);
      r.render('hidden');
      await new Promise((s) => setTimeout(s, 200));
      R.hiddenInk = ink(r);
      R.hiddenOnFirst = !!(r.objectsData[R.sources[0]].hiddenBackbone);
      const hb = r.objectsData[R.sources[1]].hiddenBackbone;
      R.hiddenLocal = hb ? Math.min(...hb) : -1;
      r.setBackboneHiddenFor(hide, false);
      r.render('unhidden');
      await new Promise((s) => setTimeout(s, 200));
      R.restoredInk = ink(r);

      // ...and the Object colour mode, which is only offered when there is
      // more than one object to tell apart.
      const colorSel = document.getElementById('colorSelect');
      const objOpt = colorSel && colorSel.querySelector('option[value="object"]');
      R.objectOptionShown = !!(objOpt && !objOpt.hidden);
      if (objOpt) {
        colorSel.value = 'object';
        colorSel.dispatchEvent(new Event('change'));
        r.render('object mode');
        await new Promise((s) => setTimeout(s, 200));
        const flat = {};
        for (let i = 0; i < r.coords.length; i++) {
          const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
          (flat[g[i]] = flat[g[i]] || new Set()).add([c.r, c.g, c.b].join(','));
        }
        R.flatPerObject = Object.values(flat).map((x) => x.size);
        colorSel.value = 'auto';
        colorSel.dispatchEvent(new Event('change'));
        r.render('back to auto');
        await new Promise((s) => setTimeout(s, 150));
      }

      // ORIENT, PICKING AND AUTO CLIP, the three things that ask "where is the
      // structure" and used to be answered by the current object alone.
      window.applyBestViewRotation(false);
      await new Promise((s) => setTimeout(s, 300));
      R.orientInk = ink(r);
      r._ensurePickProjection();
      let outside = 0;
      for (let i = 0; i < r.coords.length; i++) {
        if (!r.screenValid || !r.screenValid[i]) continue;
        const x = r.screenX[i]; const y = r.screenY[i];
        if (x < 0 || y < 0 || x > r.displayWidth || y > r.displayHeight) outside++;
      }
      R.outsideAfterOrient = outside;

      // pick where the SECOND object is drawn: the hit must belong to it.
      // pickResidueAt takes CLIENT coordinates and subtracts the canvas rect.
      const probe = R.offsets[1] + 5;
      r._ensurePickProjection();
      const rect = r.canvas.getBoundingClientRect();
      const hit = r.pickResidueAt(r.screenX[probe] + rect.left,
        r.screenY[probe] + rect.top);
      R.pickHit = hit;
      R.pickOwner = (hit >= 0 && r.ownerOf) ? (r.ownerOf(hit) || {}).name : null;

      // auto clip on a selection in the second object
      r.setResidueSelection(new Set([probe]));
      if (r.autoClip) r.autoClip(r.residueSelection);
      r.render('clipped');
      await new Promise((s) => setTimeout(s, 200));
      R.clipInk = ink(r);
      R.clipSlab = [r.clipNear, r.clipFar];
      r.setClipSlab(null, null);
      r.clearResidueSelection();
      r.render('unclipped');
      await new Promise((s) => setTimeout(s, 200));

      // THE TUBE STYLE, which has a GPU program of its own (VSTUBE) and its
      // own joint handling - a merged array must be one structure to it too.
      const styleWas = r.style;
      r.setStyle('tube');
      r.render('tube cpu');
      await new Promise((s) => setTimeout(s, 250));
      R.tubeInk = ink(r);
      R.tubeCrossing = (() => {
        const gg = r.sourceGroups();
        let k = 0;
        for (const sg of r.segmentIndices) {
          if (sg.idx2 === undefined || sg.idx2 === sg.idx1) continue;
          if (gg[sg.idx1] !== gg[sg.idx2]) k++;
        }
        return k;
      })();
      r.useGPU = true;
      r.render('tube gpu');
      await new Promise((s) => setTimeout(s, 400));
      R.tubeGpuInk = ink(r);
      R.tubeGpuTook = !!(r._tubeGPUWillTake && r._tubeGPUWillTake());
      r.useGPU = false;
      r.setStyle(styleWas);
      r.render('back to cartoon');
      await new Promise((s) => setTimeout(s, 250));

      // THE LIST UI, driven as a user drives it: press the button, click a
      // row. ONE object is on screen to begin with; All is the row that puts
      // the rest up, and pressing it again takes everything off.
      r.setShownObjects(null);          // the resting state: just the edited one
      r.render('resting');
      await new Promise((s) => setTimeout(s, 200));
      const btn = document.getElementById('objectListButton');
      R.btnOne = btn.textContent;
      btn.click();
      const rows0 = Array.from(document.querySelectorAll('.object-list-row'));
      R.rows = rows0.map((x) => x.querySelector('.object-list-name').textContent);
      R.swatches = document.querySelectorAll('.object-list-swatch').length;
      R.oneObjectInk = ink(r);
      R.oneObjectDrawn = r.drawnObjects();

      rows0[0].click();                 // All on
      await new Promise((s) => setTimeout(s, 300));
      R.afterAllDrawn = r.drawnObjects();
      R.afterAllInk = ink(r);
      R.btnAll = document.getElementById('objectListButton').textContent;

      const rowsA = Array.from(document.querySelectorAll('.object-list-row'));
      rowsA[0].click();                 // All off - every object, an empty canvas
      await new Promise((s) => setTimeout(s, 300));
      R.noneDrawn = r.drawnObjects().length;
      R.noneInk = ink(r);
      R.noneObjectsKept = Object.keys(r.objectsData).length;
      R.btnNone = document.getElementById('objectListButton').textContent;

      // ONE OBJECT'S OWN EYE, from an empty canvas: it comes back on its own,
      // and it is NOT the object being edited - which the merge path draws
      // just as well as the plain one.
      const rowsB = Array.from(document.querySelectorAll('.object-list-row'));
      rowsB[1].click();
      await new Promise((s) => setTimeout(s, 300));
      R.oneBackDrawn = r.drawnObjects();
      R.oneBackInk = ink(r);
      R.oneBackIsEdited = r.drawnObjects()[0] === r.currentObjectName;

      // ...and the other joins it rather than replacing it, which is the
      // complaint that started all of this
      const rowsC = Array.from(document.querySelectorAll('.object-list-row'));
      rowsC[2].click();
      await new Promise((s) => setTimeout(s, 300));
      R.afterJoinDrawn = r.drawnObjects();
      R.afterJoinInk = ink(r);
      R.afterJoinMulti = !!(r.multiState && r.multiState.enabled);
      R.btnSome = document.getElementById('objectListButton').textContent;

      r.setShownObjects(names);
      r.render('all again');
      await new Promise((s) => setTimeout(s, 200));

      // AN OBJECT'S COLOURS DO NOT MOVE WHEN ITS NEIGHBOUR IS SWITCHED OFF.
      // Keyed by which source it happened to be, an object was source 0 alone
      // and source 1 beside another - different palette slots, so the same
      // molecule came out two colours depending on what else was on screen,
      // in the 3D view and in the sequence strip with it.
      const colOf = (nm) => {
        const off = r.sourceOffsetOf(nm);
        const local = (r.multiState && r.multiState.enabled) ? off : 0;
        const out = [];
        for (let k = 0; k < 5; k++) {
          const c = r.getAtomColor(local + k, r._getEffectiveColorMode(local + k));
          out.push([c.r, c.g, c.b].join(','));
        }
        return out.join(' ');
      };
      const stripOf = (nm) => {
        const obj = r.objectsData[nm];
        const chs = [...new Set((obj.frames[0].chains || []))].sort();
        return chs.map((c) => {
          const k = r.getChainColorForChainId(c, nm);
          return c + ':' + [k.r, k.g, k.b].join(',');
        }).join(' ');
      };
      r.setShownObjects(names);
      r.render('both for colours');
      await new Promise((s) => setTimeout(s, 250));
      R.colBoth = colOf(names[0]);
      R.stripBoth = stripOf(names[0]);
      R.colBothSecond = colOf(names[1]);
      R.stripBothSecond = stripOf(names[1]);

      r.setShownObjects([names[0]]);
      r.render('first alone');
      await new Promise((s) => setTimeout(s, 250));
      R.colAlone = colOf(names[0]);
      R.stripAlone = stripOf(names[0]);
      // ...and the HIDDEN object's strip colours, which the strip still asks
      // for because the picker can be pointing at it
      R.stripSecondHidden = stripOf(names[1]);

      r.setShownObjects(names);
      r.render('both again');
      await new Promise((s) => setTimeout(s, 250));

      // THE STRIP IS ONE SECTION PER OBJECT ON SCREEN. It used to show the
      // object being edited and nothing else, so with two structures up it was
      // describing half the picture - and a selection in the other one was
      // invisible there.
      // ...driven the way a user drives it, so the strip has to follow the
      // LIST and not only an explicit rebuild
      const listRows = Array.from(document.querySelectorAll('.object-list-row'));
      const allRow = listRows[0];
      r.setShownObjects([names[0]]);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await new Promise((s) => setTimeout(s, 200));
      renderObjectListIfAny();
      const rowsS = Array.from(document.querySelectorAll('.object-list-row'));
      rowsS[0].click();                  // All, through the UI
      await new Promise((s) => setTimeout(s, 500));
      R.stripSections = (window.SEQ.layout() && window.SEQ.layout().objectLabelPositions
        ? window.SEQ.layout().objectLabelPositions.map((x) => x.object) : null);
      R.stripChains = (window.SEQ.layout() && window.SEQ.layout().chainLabelPositions
        ? window.SEQ.layout().chainLabelPositions.map((x) => x.object + '/' + x.chainId) : null);

      r.setShownObjects([names[0]]);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await new Promise((s) => setTimeout(s, 400));
      R.stripSectionsOne = (window.SEQ.layout() && window.SEQ.layout().objectLabelPositions
        ? window.SEQ.layout().objectLabelPositions.map((x) => x.object) : null);
      R.stripChainsOne = (window.SEQ.layout() && window.SEQ.layout().chainLabelPositions
        ? window.SEQ.layout().chainLabelPositions.map((x) => x.object + '/' + x.chainId) : null);
      r.setShownObjects(names);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await new Promise((s) => setTimeout(s, 400));

      // LIGANDS COLLAPSE TO ONE TOKEN PER LIGAND, in every section. The row
      // loop read the FIRST section's ligand groups for all of them, so no
      // section but the first could match one and every object after it drew
      // its ligands one atom per cell.
      {
        const lay3 = window.SEQ.layout();
        R.ligandTokens = {};
        for (const nm of names) {
          const cells = lay3.residuePositions.filter(
            (rp) => rp.residueData && rp.residueData.object === nm);
          R.ligandTokens[nm] = {
            tokens: cells.filter((c) => c.residueData.isLigandToken).length,
            groups: (r.objectsData[nm].ligandGroups || new Map()).size,
          };
        }
      }

      // CLICKING CHAIN A OF ONE OBJECT SELECTS THAT CHAIN A, and not the
      // other object's - "when I select chain A in one object, chain A of the
      // other object enabled to selected", which is what a bare chain id means
      // once two files are on screen.
      // EVERY section's chain A, not just the first: the hit tester found a
      // chain's box by id alone, which is another object's row once two are on
      // screen - so every chain A but the first matched nothing and selected
      // nothing at all.
      R.chainClicks = [];
      {
        // ...RE-READ FOR EVERY CLICK. A rebuild replaces the canvas element,
        // and events dispatched on the old one go nowhere - which is a probe
        // artefact, but it hid a real one: switching the edited object used to
        // rebuild the strip to draw the same rows with a different heading.
        const dpi = 200 / 96;   // the canvas is not 1:1 with the page
        for (const nm of names) {
          const lay2 = window.SEQ.layout();
          const cv = document.getElementById('sequenceCanvas');
          const bx = cv.getBoundingClientRect();
          const label = lay2.chainLabelPositions.find(
            (cp) => cp.chainId === 'A' && cp.object === nm);
          if (!label) { R.chainClicks.push({ object: nm, error: 'no chain A' }); continue; }
          r.clearResidueSelection();
          // ...MINUS THE SCROLL, which the hit tester adds back. The strip
          // can be scrolled by the time this runs, and a click computed from
          // content coordinates then lands somewhere else entirely.
          const x = bx.left + (label.x + 2) * bx.width / (cv.width / dpi);
          const y = bx.top + (label.y + 2 - (lay2.scrollTop || 0))
            * bx.height / (cv.height / dpi);
          cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
          cv.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
          await new Promise((s) => setTimeout(s, 300));
          const picked = r.residueSelection ? Array.from(r.residueSelection) : [];
          const owners = Array.from(new Set(picked.map((i) => (r.ownerOf(i) || {}).name)));
          const size = lay2.residuePositions.filter(
            (rp) => rp.residueData && rp.residueData.object === nm
              && rp.residueData.chain === 'A'
              && rp.residueData.positionIndex >= 0).length;
          R.chainClicks.push({ object: nm, count: picked.length, owners, size,
            scrollTop: lay2.scrollTop, y: Math.round(y - bx.top) });
        }
        r.clearResidueSelection();
      }

      // NOTHING ON SCREEN, NOTHING TO READ: the strip goes quiet rather than
      // listing residues of a picture that is not there, and its tools go dead
      // with it - a click in it would select something nobody can see.
      r.setShownObjects([]);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await new Promise((s) => setTimeout(s, 300));
      R.emptyStripLayout = window.SEQ.layout();
      R.emptyStripNote = !!document.querySelector('.sequence-empty-note');
      R.emptyStripDisabled = ['selectAllResidues', 'clearAllResidues',
        'invertSelection'].every((id) => (document.getElementById(id) || {}).disabled);
      r.setShownObjects(names);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await new Promise((s) => setTimeout(s, 300));
      R.backStripSections = (window.SEQ.layout() || {}).objectLabelPositions
        ? window.SEQ.layout().objectLabelPositions.map((x) => x.object) : null;
      R.backStripEnabled = !document.getElementById('selectAllResidues').disabled;

      // NO PICKER: the strip's sections say which object you are working on,
      // and clicking in one is how you change it.
      const picker = document.getElementById('objectSelect');
      R.pickerVisible = !!(picker && picker.offsetParent !== null);
      R.pickerOptions = picker
        ? Array.from(picker.options).map((o) => o.value) : null;

      // SELECTING IN A SECTION ADOPTS ITS OBJECT. Click a residue of the
      // object that is NOT being edited, and the edit target follows - without
      // the picture moving.
      const other = names.find((n) => n !== r.currentObjectName);
      const lay = window.SEQ.layout();
      const cell = lay.residuePositions.find(
        (rp) => rp.residueData && rp.residueData.object === other
          && rp.residueData.positionIndex >= 0);
      const canvas = document.getElementById('sequenceCanvas');
      const box = canvas.getBoundingClientRect();
      const inkBefore = ink(r);
      const drawnBefore = r.drawnObjects();
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true,
        clientX: box.left + cell.x + 2, clientY: box.top + cell.y + 2 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true,
        clientX: box.left + cell.x + 2, clientY: box.top + cell.y + 2 }));
      await new Promise((s) => setTimeout(s, 400));
      R.afterPickCurrent = r.currentObjectName;
      R.afterPickDrawn = r.drawnObjects();
      R.afterPickSelection = r.residueSelection ? Array.from(r.residueSelection) : [];
      R.afterPickOwner = (R.afterPickSelection.length && r.ownerOf)
        ? (r.ownerOf(R.afterPickSelection[0]) || {}).name : null;
      R.afterPickInk = ink(r);
      R.wantedObject = other;
      R.inkBefore = inkBefore;
      R.drawnBefore = drawnBefore;

      // ...and the GPU path, in the SAME page load, against the CPU picture as
      // it stands NOW. Comparing with the ink from the top of the run was
      // fragile: Orient has moved the camera since, so the two are pictures of
      // different views and the tolerance was absorbing that rather than
      // measuring the GPU.
      R.cpuBeforeGpu = ink(r);
      r.useGPU = true;
      r.render('gpu');
      await new Promise((s) => setTimeout(s, 400));
      R.gpuInk = ink(r);
      R.gpuTook = !!(r._gpuWillDraw && r._gpuWillDraw());
      R.gpuError = String(window.__gpuLastError || '');
      if (P.get('png') === '1') R.png = r.canvas.toDataURL('image/png');
      r.useGPU = false;
      r.render('back');
      // A SELECTION THAT REACHES BOTH OBJECTS, and the three edits that used
      // to take only the edited object's share of it - silently.
      {
        r.setShownObjects(names);
        window.SEQ.buildView();
        await new Promise((s) => setTimeout(s, 300));
        const offs = r.multiState.sourceOffsets;
        const across = new Set([offs[0] + 1, offs[0] + 2, offs[1] + 1, offs[1] + 2]);
        r.setResidueSelection(across);
        R.acrossObjects = r.objectsInSelection();
        const before = names.map((n) => r.objectsData[n].frames[0].coords.length);

        // COPY: one new object per structure the selection reached
        const madeBefore = Object.keys(r.objectsData).length;
        const made = r.extractSelection();
        R.copyMade = Array.isArray(made) ? made : [made];
        R.copyNewObjects = Object.keys(r.objectsData).length - madeBefore;
        R.copySizes = R.copyMade.map(
          (n) => (r.objectsData[n] ? r.objectsData[n].frames[0].coords.length : -1));

        // DELETE: from every object it reached
        r.setShownObjects(names);
        r.setResidueSelection(new Set([offs[0] + 1, offs[1] + 1]));
        R.deleted = r.deleteSelection();
        R.sizesAfterDelete = names.map((n) => r.objectsData[n].frames[0].coords.length);
        R.sizesBeforeDelete = before;
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""


def build_probe():
    src = open(os.path.join(ROOT, "index.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src.replace("</body>", PAGE_JS + "</body>"))


def serve(port, box):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, *a):
            pass

        def do_POST(self):
            box.append(json.loads(self.rfile.read(
                int(self.headers.get("Content-Length", 0)))))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a", help="a structure file in the repo root")
    ap.add_argument("b", help="another one")
    ap.add_argument("--port", type=int, default=8933)
    ap.add_argument("--png")
    ap.add_argument("--timeout", type=int, default=180)
    a = ap.parse_args()
    if not os.path.exists(CHROME):
        sys.exit("Google Chrome not found at " + CHROME)
    build_probe()
    box = []
    httpd = serve(a.port, box)
    url = (f"http://127.0.0.1:{a.port}/_multi_probe.html?a={a.a}&b={a.b}"
           + ("&png=1" if a.png else ""))
    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--user-data-dir=/tmp/py2dmol-multi-{os.getpid()}",
         "--no-first-run", "--disable-extensions", "--window-size=1200,1200", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + a.timeout
    while not box and time.time() < deadline:
        time.sleep(0.5)
    proc.kill()
    httpd.shutdown()
    shutil.rmtree(f"/tmp/py2dmol-multi-{os.getpid()}", ignore_errors=True)
    try:
        os.remove(PROBE)
    except OSError:
        pass
    if not box:
        sys.exit("no result posted within %ds" % a.timeout)
    R = box[0]
    if R.get("error"):
        sys.exit("page error: " + R["error"])
    png = R.pop("png", None)
    cpu = R.pop("pngCpu", None)
    if png and a.png:
        open(a.png, "wb").write(base64.b64decode(png.split(",", 1)[1]))
    if cpu and a.png:
        open(a.png.replace(".png", "_cpu.png"), "wb").write(
            base64.b64decode(cpu.split(",", 1)[1]))

    print(f"objects: {R['objects']} on {R['renderer']}")
    print(f"  plain load: drew {R.get('plainDrawn')}, {R.get('plainN')} positions,"
          f" merge {R.get('plainMulti')}, {R.get('plainVisible')} visible")
    print(f"  one:   {R['oneN']:6d} positions, {R['oneInk']:8d} ink")
    print(f"  both:  {R['bothN']:6d} positions, {R['bothInk']:8d} ink"
          f"  (merge {'on' if R['multi'] else 'OFF'}, offsets {R['offsets']})")
    print(f"  map covers {R['mapLen']} of {R['bothN']} positions")
    print(f"  {R['segments']} segments, {R['crossing']} of them across the join")
    print(f"  auto per object: {R.get('autos')}; first position of each:"
          f" {R['colors']}")
    print(f"  colours per object: {[len(x) for x in R.get('perSource', [])]},"
          f" shared: {R.get('sharedColors')}")
    print(f"  modes: {R.get('modes')}")
    print(f"  painted: {R.get('painted')}")
    print(f"  hiding 40 of the second object: {R['hiddenInk']} ink,"
          f" back to {R['restoredInk']}; first object touched:"
          f" {R['hiddenOnFirst']}, second object's lowest index {R['hiddenLocal']}")
    print(f"  list: rows {R.get('rows')}, swatches {R.get('swatches')};"
          f" button {R.get('btnOne')!r} -> {R.get('btnAll')!r} -> {R.get('btnNone')!r}")
    print(f"  All: {R.get('oneObjectDrawn')} ({R.get('oneObjectInk')} ink) ->"
          f" {R.get('afterAllDrawn')} ({R.get('afterAllInk')}) -> nothing"
          f" ({R.get('noneInk')} ink, {R.get('noneObjectsKept')} objects kept)")
    print(f"  eyes from empty: {R.get('oneBackDrawn')} ({R.get('oneBackInk')} ink)"
          f" -> {R.get('afterJoinDrawn')} ({R.get('afterJoinInk')} ink,"
          f" merge {R.get('afterJoinMulti')})")
    print(f"  colours of {R['objects'][0]}: {R.get('colAlone')} alone,"
          f" {R.get('colBoth')} beside another")
    print(f"  strip of {R['objects'][0]}: {R.get('stripAlone')}")
    print(f"  strip of {R['objects'][1]}: {R.get('stripBothSecond')} shown,"
          f" {R.get('stripSecondHidden')} hidden")
    print(f"  strip: sections {R.get('stripSections')}, chains {R.get('stripChains')};"
          f" one object -> headings {R.get('stripSectionsOne')},"
          f" chains {R.get('stripChainsOne')}")
    for c in R.get("chainClicks", []):
        print(f"  chain A of {c['object']}: selected {c.get('count')} of"
              f" {c.get('size')}, from {c.get('owners')}"
              f" (scrollTop {c.get('scrollTop')}, clicked y {c.get('y')})")
    print(f"  ligand tokens: {R.get('ligandTokens')}")
    print(f"  across objects {R.get('acrossObjects')}: Copy made"
          f" {R.get('copyMade')} ({R.get('copySizes')} residues), Delete took"
          f" {R.get('sizesBeforeDelete')} -> {R.get('sizesAfterDelete')}")
    print(f"  empty strip: layout {R.get('emptyStripLayout')}, note"
          f" {R.get('emptyStripNote')}, tools dead {R.get('emptyStripDisabled')};"
          f" back -> {R.get('backStripSections')}, live {R.get('backStripEnabled')}")
    print(f"  no picker on screen: {not R.get('pickerVisible')};"
          f" clicking in {R.get('wantedObject')}'s section -> editing"
          f" {R.get('afterPickCurrent')}, selected a residue of"
          f" {R.get('afterPickOwner')}, drawn {R.get('afterPickDrawn')}")
    print(f"  orient: {R.get('orientInk')} ink,"
          f" {R.get('outsideAfterOrient')} positions off canvas;"
          f" pick at the second object -> {R.get('pickOwner')};"
          f" clip {R.get('clipSlab')} leaves {R.get('clipInk')} ink")
    print(f"  Object mode offered: {R.get('objectOptionShown')},"
          f" colours per object in it: {R.get('flatPerObject')}")
    print(f"  tube:  {R.get('tubeInk')} ink, {R.get('tubeCrossing')} crossing;"
          f" gpu {R.get('tubeGpuInk')} (path taken: {R.get('tubeGpuTook')})")
    print(f"  gpu:   {R['gpuInk']:8d} ink (path taken: {R['gpuTook']})"
          + (f"  DECLINED: {R['gpuError']}" if R.get("gpuError") else ""))

    bad = []
    if R.get("plainDrawn") != [R["objects"][1]]:
        bad.append(f"a plain load of two files drew {R.get('plainDrawn')} - the"
                   " resting state is the object being edited, on its own")
    if R.get("plainMulti"):
        bad.append("a plain load merged two objects without being asked to")
    if R.get("plainVisible") != R.get("plainN"):
        bad.append(f"only {R.get('plainVisible')} of {R.get('plainN')} positions"
                   " are visible after a plain load")
    if not R["multi"]:
        bad.append("the merge did not switch on")
    if R["mapLen"] != R["bothN"]:
        bad.append("the source map does not cover every position")
    if R["crossing"]:
        bad.append(f"{R['crossing']} segments join two objects")
    if R.get("sharedColors"):
        bad.append(f"two objects share colours {R['sharedColors']}")
    if R["hiddenOnFirst"]:
        bad.append("hiding the second object's backbone wrote onto the first")
    if R["hiddenLocal"] != 0:
        bad.append("the second object's set is not in its own numbering")
    if R["hiddenInk"] >= R["bothInk"]:
        bad.append("hiding 40 residues did not remove any ink")
    if abs(R["restoredInk"] - R["bothInk"]) > 0.02 * R["bothInk"]:
        bad.append("unhiding did not restore the picture")
    if R.get("outsideAfterOrient"):
        bad.append(f"{R['outsideAfterOrient']} positions are off canvas after Orient")
    if R.get("pickOwner") != R["sources"][1]:
        bad.append(f"a pick on the second object reported {R.get('pickOwner')}")
    if not (0 < R.get("clipInk", 0) < R["bothInk"]):
        bad.append(f"auto clip on one object left {R.get('clipInk')} ink")
    if R.get("rows") != ["All"] + R["objects"]:
        bad.append(f"the list reads {R.get('rows')} - All first, then the objects")
    if R.get("swatches"):
        bad.append("the rows still carry colour swatches")
    if R.get("oneObjectDrawn") != [R["objects"][1]]:
        bad.append(f"the resting state drew {R.get('oneObjectDrawn')}")
    if R.get("btnOne") != "1/2":
        bad.append(f"the button reads {R.get('btnOne')!r} with one object on screen")
    if R.get("afterAllDrawn") != R["objects"]:
        bad.append(f"All left {R.get('afterAllDrawn')} on screen")
    if R.get("btnAll") != "All":
        bad.append(f"the button reads {R.get('btnAll')!r} after All")
    if not (R.get("afterAllInk", 0) > R.get("oneObjectInk", 0)):
        bad.append("All did not add any ink")
    if R.get("noneDrawn") != 0:
        bad.append(f"All switched off left {R.get('noneDrawn')} drawn")
    if R.get("noneInk", 1) != 0:
        bad.append(f"an empty canvas has {R.get('noneInk')} ink on it")
    if R.get("noneObjectsKept") != len(R["objects"]):
        bad.append("switching objects off unloaded them")
    if R.get("btnNone") != "0/2":
        bad.append(f"the button reads {R.get('btnNone')!r} with nothing on screen")
    if R.get("oneBackDrawn") != [R["objects"][0]]:
        bad.append(f"one eye from an empty canvas drew {R.get('oneBackDrawn')}")
    if R.get("oneBackIsEdited"):
        bad.append("this leg is meant to draw the object that is NOT being edited")
    if not R.get("oneBackInk"):
        bad.append("one eye from an empty canvas drew nothing")
    if R.get("afterJoinDrawn") != R["objects"]:
        bad.append(f"lighting a second eye left {R.get('afterJoinDrawn')} drawn -"
                   " it should JOIN what is on screen, not replace it")
    if not R.get("afterJoinMulti"):
        bad.append("two objects on screen are not merged")
    # NOT "more ink than before": adding an object re-frames the camera to fit
    # both, which SHRINKS the one that was there - 1BBH alone measured 82,800
    # ink and the pair 55,919. Ink is not a proxy for "something was added" the
    # moment the framing can change; the drawn list and the merge are.
    if not R.get("afterJoinInk"):
        bad.append("two objects on screen drew nothing")
    if R.get("btnSome") != "All":
        bad.append(f"the button reads {R.get('btnSome')!r} with both on screen")
    if R.get("colBoth") != R.get("colAlone"):
        bad.append(f"the first object is drawn {R.get('colBoth')} beside another"
                   f" and {R.get('colAlone')} on its own")
    if R.get("stripBoth") != R.get("stripAlone"):
        bad.append(f"its strip reads {R.get('stripBoth')} beside another"
                   f" and {R.get('stripAlone')} on its own")
    if R.get("stripBothSecond") != R.get("stripSecondHidden"):
        bad.append(f"the second object's strip reads {R.get('stripBothSecond')}"
                   f" on screen and {R.get('stripSecondHidden')} hidden")
    if R.get("stripBoth") == R.get("stripBothSecond"):
        bad.append("both objects' strips are the same colours - chain A of one"
                   " is chain A of the other again")
    if R.get("stripSections") != R["objects"]:
        bad.append(f"the strip has sections {R.get('stripSections')} with both"
                   " objects on screen")
    if R.get("stripSectionsOne"):
        bad.append("a single object's strip has a heading it does not need")
    chains = R.get("stripChains") or []
    if len({c.split('/')[0] for c in chains}) != 2:
        bad.append(f"the strip's chain rows come from {chains}")
    for c in R.get("chainClicks", []):
        if c.get("error"):
            bad.append(f"{c['object']}: {c['error']}")
        elif c["owners"] != [c["object"]]:
            bad.append(f"clicking chain A of {c['object']} selected residues of"
                       f" {c['owners']}")
        elif c["count"] != c["size"]:
            bad.append(f"clicking chain A of {c['object']} selected {c['count']}"
                       f" residues, and that chain has {c['size']}")
    for nm, lig in (R.get("ligandTokens") or {}).items():
        if lig["groups"] and lig["tokens"] != lig["groups"]:
            bad.append(f"{nm} drew {lig['tokens']} ligand tokens for"
                       f" {lig['groups']} ligands - they are not collapsing")
    if len(R.get("acrossObjects", [])) != 2:
        bad.append(f"the test selection did not reach both objects: {R.get('acrossObjects')}")
    if R.get("copyNewObjects") != 2:
        bad.append(f"Copy made {R.get('copyNewObjects')} objects from a selection"
                   " that reached two - it used to take one object's share only")
    if sorted(R.get("copySizes", [])) != [2, 2]:
        bad.append(f"the copies came out {R.get('copySizes')}, not two residues each")
    if not R.get("deleted"):
        bad.append("Delete across two objects reported nothing")
    lost = [b - a for a, b in zip(R.get("sizesAfterDelete", []), R.get("sizesBeforeDelete", []))]
    if lost != [1, 1]:
        bad.append(f"Delete removed {lost} residues from the two objects, not one each")
    if R.get("emptyStripLayout") is not None:
        bad.append("the strip still laid out rows with nothing on screen")
    if not R.get("emptyStripNote"):
        bad.append("the strip does not say why it is empty")
    if not R.get("emptyStripDisabled"):
        bad.append("the strip's tools are still live with nothing on screen")
    if R.get("backStripSections") != R["objects"]:
        bad.append(f"switching objects back on left the strip {R.get('backStripSections')}")
    if not R.get("backStripEnabled"):
        bad.append("the strip's tools stayed dead after objects came back")
    if R.get("pickerVisible"):
        bad.append("the object picker is still on screen - the strip's sections"
                   " answer that question now")
    if R.get("pickerOptions") != R["objects"]:
        bad.append(f"the hidden select no longer tracks the objects:"
                   f" {R.get('pickerOptions')}")
    if R.get("afterPickCurrent") != R.get("wantedObject"):
        bad.append(f"clicking in {R.get('wantedObject')}'s section left"
                   f" {R.get('afterPickCurrent')} as the edited object")
    if R.get("afterPickOwner") != R.get("wantedObject"):
        bad.append(f"the click selected a residue of {R.get('afterPickOwner')}")
    if R.get("afterPickDrawn") != R.get("drawnBefore"):
        bad.append(f"clicking in a section changed what is DRAWN:"
                   f" {R.get('afterPickDrawn')}")
    if not R.get("objectOptionShown"):
        bad.append("the Object colour mode is not offered with two objects up")
    if R.get("flatPerObject") not in ([1, 1], None):
        bad.append(f"Object mode is not one colour per object: {R.get('flatPerObject')}")
    if R.get("tubeCrossing"):
        bad.append(f"{R['tubeCrossing']} tube segments join two objects")
    if not R.get("tubeInk"):
        bad.append("the tube style drew nothing")
    if abs(R.get("tubeGpuInk", 0) - R.get("tubeInk", 1)) > 0.2 * R.get("tubeInk", 1):
        bad.append("the GPU tube picture is not the CPU one")
    if R["gpuInk"] <= 0:
        bad.append("the GPU path drew nothing")
    if abs(R["gpuInk"] - R.get("cpuBeforeGpu", 1)) > 0.05 * R.get("cpuBeforeGpu", 1):
        bad.append(f"the GPU picture ({R['gpuInk']} ink) is not the CPU one"
                   f" ({R.get('cpuBeforeGpu')})")
    for m in bad:
        print("FAIL:", m)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
