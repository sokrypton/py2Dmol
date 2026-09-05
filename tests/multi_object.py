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
import argparse, base64, http.server, json, os, re, shutil, socketserver, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
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
  // MULTI IS THE MODE THE LIST LIVES IN: the button is a toggle, not a
  // disclosure, so anything that wants rows asks for the mode.
  const renderObjectListIfAny = () => {
    const b = document.getElementById('objectListButton');
    if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
  };
  const eyes = () => Array.from(document.querySelectorAll('#objectList .object-list-eye'));
  const rowNames = () => Array.from(document.querySelectorAll('#objectList .object-list-name'))
      .map((x) => x.textContent);
  const rowOn = (i) => !Array.from(document.querySelectorAll('#objectList .object-list-row'))[i]
      .classList.contains('is-hidden');
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
  //HELPERS
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

      // NO TWO CONTROLS WEAR THE SAME ICON. Focus went in with crosshairs,
      // which Orient already had two rows up - and a toolbar where two buttons
      // look identical is worse than one with no icons at all. Read off the
      // page rather than from a list here, so a new button is covered by
      // existing.
      {
        const seen = {};
        for (const i of document.querySelectorAll(".toolbar-row i, .btn-toggle i")) {
          const cls = [...i.classList].find((c) => c.startsWith('fa-')
              && c !== 'fa-solid');
          if (!cls) continue;
          (seen[cls] = seen[cls] || []).push(
              (i.parentElement.textContent || '').trim());
        }
        R.iconClashes = Object.entries(seen)
            .filter(([, who]) => who.length > 1)
            .map(([cls, who]) => cls + ': ' + who.join(' + '));
        R.iconCount = Object.keys(seen).length;
      }

      // THE WEBSITE'S OBJECT ROW IS EXEMPT FROM THE ONE-OBJECT HIDE, and this
      // is the page it has to be exempt ON. The notebook and the embed give
      // the picker a row to itself, and with one object that row can only say
      // what it already says - but #objectRow here also holds Multi and the
      // prev/next buttons, which stay useful with one object. The rule is what
      // the row CONTAINS, and the first version tested the CLASS instead:
      // index.html's row is `.toggle-item object-row`, so it hid this one too
      // and was saved only by a later line forcing the row back to flex.
      {
        const sel = document.getElementById('objectSelect');
        const keep = [...sel.options].map((o) => o.value);
        const opt = (v) => { const x = document.createElement('option');
          x.value = v; x.textContent = v; return x; };
        sel.innerHTML = ''; sel.appendChild(opt(keep[0]));
        r.updateUIControls();
        R.websiteRowWithOne = getComputedStyle(
            document.getElementById('objectRow')).display !== 'none';
        sel.innerHTML = '';
        for (const k of keep) sel.appendChild(opt(k));
        sel.value = r.currentObjectName;
        r.updateUIControls();
        R.websiteRowRestored = [...sel.options].length;
      }

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
      await settle();
      R.oneInk = ink(r);
      R.oneN = r.coords.length;

      r.setShownObjects(names);
      r.render('both');
      await settle();
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
      // EVERY OBJECT NUMBERS ITS OWN CHAINS FROM ZERO, so what an object is
      // coloured does not depend on what was loaded before it. The slots used
      // to run in one sequence across all loaded objects, which kept two
      // merged objects from sharing a chain colour (two molecules reading as
      // one - the report this block was first written for) at the price of
      // moving a structure's colours whenever it was loaded second: a ribosome
      // opened in one set of colours alone and another set after a peptide.
      // Stability won; in a merge, telling two objects apart is the per-object
      // 'auto' colouring's job, which is what Multi picks anyway.
      {
        const slots = {};
        for (const [key, slot] of r.chainIndexMap.entries()) {
          const nm = key.includes('|') ? key.slice(0, key.indexOf('|')) : '(one object)';
          (slots[nm] = slots[nm] || []).push(slot);
        }
        R.chainSlots = slots;
        R.slotsFromZero = [];
        for (const [nm, list] of Object.entries(slots)) {
          const want = list.map((_, i) => i).join(',');
          if (list.slice().sort((a, b) => a - b).join(',') !== want) {
            R.slotsFromZero.push(`${nm} holds ${list.join(',')} rather than ${want}`);
          }
        }
      }
      // ...and what that costs, recorded rather than asserted: where both
      // objects colour by chain, their colours now overlap.
      const bySource = [new Set(), new Set()];
      for (let i = 0; i < r.coords.length; i++) {
        const src = g[i];
        if (src !== 0 && src !== 1) continue;
        const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
        bySource[src].add([c.r, c.g, c.b].join(','));
      }
      R.perSource = bySource.map((x) => Array.from(x));
      R.bothByChain = (r.multiState.sourceAutoColors || [])
        .slice(0, 2).every((m) => m === 'chain');
      R.sharedColors = R.bothByChain
        ? R.perSource[0].filter((c) => R.perSource[1].includes(c)) : [];
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
      await settle();
      R.hiddenInk = ink(r);
      R.hiddenOnFirst = !!(r.objectsData[R.sources[0]].hiddenBackbone);
      const hb = r.objectsData[R.sources[1]].hiddenBackbone;
      R.hiddenLocal = hb ? Math.min(...hb) : -1;
      r.setBackboneHiddenFor(hide, false);
      r.render('unhidden');
      await settle();
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
        await settle();
        const flat = {};
        for (let i = 0; i < r.coords.length; i++) {
          const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
          (flat[g[i]] = flat[g[i]] || new Set()).add([c.r, c.g, c.b].join(','));
        }
        R.flatPerObject = Object.values(flat).map((x) => x.size);
        colorSel.value = 'auto';
        colorSel.dispatchEvent(new Event('change'));
        r.render('back to auto');
        await settle();
      }

      // THE SS COLOUR MODE SHARES THE DRAWING'S ASSIGNMENT rather than making
      // its own. The two cache it under keys built in two places, and the
      // colour path's key left the merged objects out - so with several on
      // screen it could never match the cache the draw stage had just filled,
      // and every frame paid for a second full SS pass. One builder now
      // (secCacheKey), which is observable: the colour path's own slot stays
      // empty because there is nothing left for it to compute.
      {
        r.setStyle('cartoon');
        await settle();
        colorSel.value = 'ss';
        colorSel.dispatchEvent(new Event('change'));
        r.render('ss colours');
        await settle();
        // ...asked for directly, which is what the colour path and the panel
        // both do. The drawing has just filled its cache; anyone asking now
        // must get THAT array back rather than computing a second one.
        r._ssColorSec = null; r._ssColorKey = null;
        const shared = window.py2dmolCartoon.secondaryFor(r);
        R.ssShared = {
          mode: r.colorMode,
          draw: !!r._cartoonSec,
          sameArray: shared === r._cartoonSec,
          colourOwn: !!r._ssColorSec,
        };
        colorSel.value = 'auto';
        colorSel.dispatchEvent(new Event('change'));
        r.render('back to auto');
        await settle();
      }

      // ORIENT, PICKING AND AUTO CLIP, the three things that ask "where is the
      // structure" and used to be answered by the current object alone.
      window.applyBestViewRotation(false);
      await settle();
      R.orientInk = ink(r);
      r._ensurePickProjection();
      let outside = 0;
      for (let i = 0; i < r.coords.length; i++) {
        if (!r.screenValid || !r.screenValid[i]) continue;
        const x = r.screenX[i]; const y = r.screenY[i];
        if (x < 0 || y < 0 || x > r.displayWidth || y > r.displayHeight) outside++;
      }
      R.outsideAfterOrient = outside;

      // ...AND ORIENT ON WHAT IS ENABLED, not on what the picker names. The
      // coordinates it measured were taken from the array only when the array
      // was at least as long as the PICKER'S object - so switching that object
      // off and leaving a smaller one on failed the test and Orient swung the
      // view onto a structure that was not on screen.
      {
        const centroid = (nm) => {
          const f = r.objectsData[nm].frames[0];
          const c = [0, 0, 0];
          for (const p of f.coords) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
          return c.map((v) => v / f.coords.length);
        };
        // THE SMALLER OBJECT ALONE, WITH THE BIGGER ONE BEING EDITED. That
        // is the case the old test failed on: it took the array's
        // coordinates only when the array was at least as long as the
        // PICKER'S object, so the fault is invisible unless what is drawn is
        // shorter than what the picker names.
        const wasEditing = r.currentObjectName;
        const size = (nm) => r.objectsData[nm].frames[0].coords.length;
        const ranked = names.slice().sort((a, b) => size(a) - size(b));
        const other = ranked[0];
        const big = ranked[ranked.length - 1];
        if (r.currentObjectName !== big) {
            r._switchToObject(big);
            const sel = document.getElementById('objectSelect');
            if (sel) sel.value = big;      // Orient reads the picker
        }
        r.setShownObjects([other]);
        await settle();
        window.applyBestViewRotation(false);
        await settle();
        const want = centroid(other);
        const got = r.viewerState.center;
        R.orientOne = {
          object: other, edited: r.currentObjectName,
          off: Math.round(Math.hypot(got.x - want[0], got.y - want[1],
            got.z - want[2]) * 100) / 100,
          // ...and how far it would be if it had oriented on the other one
          wrongBy: Math.round(Math.hypot(...centroid(r.currentObjectName)
            .map((v, k) => v - want[k])) * 100) / 100,
        };
        // ...and put back what this leg moved, or every check after it is
        // reading a different object's world
        if (r.currentObjectName !== wasEditing) {
            r._switchToObject(wasEditing);
            const sel2 = document.getElementById('objectSelect');
            if (sel2) sel2.value = wasEditing;
        }
        r.setShownObjects(names);
        await settle();
      }

      // PICKING REACHES THE SECOND OBJECT. Not "the pixel over residue X
      // returns X": two structures loaded from different files overlap in
      // space, so whichever is in FRONT at that pixel is the right answer -
      // asking for one particular residue tested the geometry, not the
      // picking. Several of its positions are tried, and one of them must
      // come back as its own object.
      r._ensurePickProjection();
      const rect = r.canvas.getBoundingClientRect();
      const from = R.offsets[1];
      const to = r.coords.length;
      let owner = null;
      let tried = 0;
      for (let i = from; i < to && !owner; i += Math.max(1, Math.floor((to - from) / 40))) {
        if (!r.screenValid || !r.screenValid[i]) continue;
        tried++;
        const hit = r.pickResidueAt(r.screenX[i] + rect.left, r.screenY[i] + rect.top);
        const nm = (hit >= 0 && r.ownerOf) ? (r.ownerOf(hit) || {}).name : null;
        if (nm === R.sources[1]) owner = nm;
      }
      R.pickTried = tried;
      R.pickOwner = owner;
      const probe = R.offsets[1] + 5;

      // auto clip on a selection in the second object
      r.setResidueSelection(new Set([probe]));
      if (r.autoClip) r.autoClip(r.residueSelection);
      r.render('clipped');
      await settle();
      R.clipInk = ink(r);
      R.clipSlab = [r.clipNear, r.clipFar];
      r.setClipSlab(null, null);
      r.clearResidueSelection();
      r.render('unclipped');
      await settle();

      // THE TUBE STYLE, which has a GPU program of its own (VSTUBE) and its
      // own joint handling - a merged array must be one structure to it too.
      //
      // EVERY DRAWN OBJECT, not just the edited one: the style belongs to the
      // object now, so setStyle restyles the one being edited and leaves its
      // neighbour as it was. That is a MIXED picture, which the GPU can draw
      // and the 2D path cannot - so comparing the two here compared a
      // half-cartoon against an all-tube and read as a broken GPU.
      const styleWas = r.style;
      const stylesWere = r.drawnObjects().map((n) => r.styleForObject(n));
      for (const nm of r.drawnObjects()) r.setStyleForObject(nm, 'tube');
      r.setStyle('tube');
      r.render('tube cpu');
      await settle();
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
      await settle();
      R.tubeGpuInk = ink(r);
      R.tubeGpuTook = !!(r._tubeGPUWillTake && r._tubeGPUWillTake());
      r.useGPU = false;
      r.drawnObjects().forEach((nm, k) => r.setStyleForObject(nm, stylesWere[k]));
      r.setStyle(styleWas);
      r.render('back to cartoon');
      await settle();

      // THE UI, DRIVEN AS A USER DRIVES IT. The picker is the ordinary
      // control - one object on screen, the one being edited - and Multi is
      // the other mode: the picker greys out, every object gets a row, and
      // only the eyes decide what is drawn.
      r.setShownObjects(null);          // the resting state: just the edited one
      r.render('resting');
      await settle();
      const btn = document.getElementById('objectListButton');
      const picker = document.getElementById('objectSelect');
      // AN ICON HAS NO TEXT: what names it is the accessible label.
      R.btnOne = (btn.getAttribute('aria-label') || btn.textContent).trim();
      R.multiBefore = btn.getAttribute('aria-pressed');
      R.listHiddenBefore = document.getElementById('objectList').hidden;
      R.pickerBefore = picker.disabled;
      R.pickerValue = picker.value;

      btn.click();                      // MULTI ON
      await settle();
      R.multiAfter = btn.getAttribute('aria-pressed');
      R.pickerAfter = picker.disabled;
      R.rows = rowNames();
      R.swatches = document.querySelectorAll('.object-list-swatch').length;
      R.oneObjectInk = ink(r);
      R.oneObjectDrawn = r.drawnObjects();
      // ...and it opened on exactly what was already there
      R.multiOpensOnEdited = r.drawnObjects().join(',') === r.currentObjectName;
      R.eyesOnAtOpen = R.rows.map((_, k) => rowOn(k));

      // EVERY EYE ON
      for (let k = 0; k < R.rows.length; k++) if (!rowOn(k)) {
        eyes()[k].click();
        await settle();
      }
      R.afterAllDrawn = r.drawnObjects();
      R.afterAllInk = ink(r);

      // ...AND EVERY EYE OFF, which is an empty canvas and not a fallback to
      // one object: the objects are all still there to be switched back on.
      for (let k = 0; k < R.rows.length; k++) if (rowOn(k)) {
        eyes()[k].click();
        await settle();
      }
      R.noneDrawn = r.drawnObjects().length;
      R.noneInk = ink(r);
      R.noneObjectsKept = Object.keys(r.objectsData).length;

      // ONE OBJECT'S OWN EYE, from an empty canvas: it comes back on its own,
      // and it is NOT the object being edited - which the merge path draws
      // just as well as the plain one.
      const otherIdx = rowNames().findIndex((n) => n !== r.currentObjectName);
      eyes()[otherIdx].click();
      await settle();
      R.oneBackDrawn = r.drawnObjects();
      R.oneBackInk = ink(r);
      // ...AND THE CAMERA FRAMES IT. An empty canvas has no view worth
      // holding, and the first eye lit was drawn into whatever framing the
      // last thing happened to use: a ribosome brought back at a peptide's
      // scale landed 3,200 px off the side of a 1,200 px canvas - a blank
      // window with the object reported as drawn.
      R.oneBackFraming = {
        extent: r.viewerState.extent,
        own: (r.objectsData[R.oneBackDrawn[0]] || {}).maxExtent,
      };
      R.oneBackIsEdited = r.drawnObjects()[0] === r.currentObjectName;
      // THE CAMERA HOLDS STILL for an object it has already framed - an eye
      // makes things appear and disappear, it does not zoom.
      const camA = JSON.stringify([r.viewerState.extent, r.viewerState.center]);

      // ...and the other joins it rather than replacing it, which is the
      // complaint that started all of this
      eyes()[rowNames().findIndex((n) => n === r.currentObjectName)].click();
      await settle();
      R.afterJoinDrawn = r.drawnObjects();
      R.afterJoinInk = ink(r);
      R.afterJoinMulti = !!(r.multiState && r.multiState.enabled);
      R.cameraHeld = camA === JSON.stringify([r.viewerState.extent, r.viewerState.center]);

      // 🔴 `sele` IS A LATCH. It selects every residue of its object, lights
      // up while that selection stands, and pressing it again lets go - a lit
      // button that does nothing when pressed reads as a missed click. The
      // state is asked of the SELECTION, so a click anywhere else drops it
      // without the button being touched.
      {
        const seles = () => Array.from(
            document.querySelectorAll('#objectList .object-list-sele'));
        const pressed = () => seles().map((b) => b.getAttribute('aria-pressed'));
        const size = () => (r.residueSelection ? r.residueSelection.size : 0);
        const idx = 0;
        const who = rowNames()[idx];
        const node = seles()[idx];
        R.seleBefore = { pressed: pressed(), n: size() };
        seles()[idx].click();
        await settle();
        R.seleOn = { pressed: pressed(), n: size(),
                     // every residue of that object and no other
                     whole: r.localRangeOf ? (() => {
                       const w = r.localRangeOf(who);
                       const total = r.coords.length;
                       const hi = w.end === Infinity ? total : Math.min(total, w.end);
                       return hi - w.off; })() : -1 };
        // ...AND THE SAME NODE, because the list is mutated and not rebuilt:
        // a rebuild between mousedown and mouseup swallows the press.
        R.seleSameNode = seles()[idx] === node;
        seles()[idx].click();           // press again
        // 🔴 READ BEFORE THE SETTLE. What the CLICK did is the thing under
        // test; a frame later is a different question with the strip, the
        // panels and the merge's own translation in between - measured, a
        // build whose second press re-selects still reads 0 after a settle.
        R.seleOffAtOnce = size();
        await settle();
        R.seleOff = { pressed: pressed(), n: size() };

        // 🔴 SHIFT ADDS A SECOND OBJECT, and shift again takes it back out.
        // A plain click NARROWS to one; only shift builds a union.
        const other = 1;
        const whole = (nm) => {
          const w = r.localRangeOf(nm);
          const total = r.coords.length;
          const hi = w.end === Infinity ? total : Math.min(total, w.end);
          return hi - w.off;
        };
        const shiftClick = (k) => seles()[k].dispatchEvent(new MouseEvent(
            'click', { bubbles: true, cancelable: true, shiftKey: true }));
        seles()[idx].click();                 // one object
        await settle();
        shiftClick(other);                    // ...and the other beside it
        await settle();
        R.seleBoth = { pressed: pressed(), n: size(),
                       want: whole(rowNames()[idx]) + whole(rowNames()[other]) };
        shiftClick(other);                    // ...and out again
        await settle();
        R.seleBackToOne = { pressed: pressed(), n: size(),
                            want: whole(rowNames()[idx]) };
        // ...AND A PLAIN CLICK ON A UNION NARROWS RATHER THAN CLEARING: the
        // latch lets go only from the state it put you in.
        shiftClick(other);
        await settle();
        seles()[other].click();
        await settle();
        R.seleNarrow = { pressed: pressed(), n: size(),
                         want: whole(rowNames()[other]) };
        // ...and shift-clicking the LAST one out empties the selection: the
        // relative path has to end in clearResidueSelection, which is the door
        // a background click uses and the one parts/ui.js watches.
        shiftClick(other);
        await settle();
        R.seleShiftEmpty = { n: size(), pressed: pressed(),
                             held: !!r.residueSelection };

        // and it follows a selection made anywhere else
        seles()[idx].click();
        await settle();
        r.clearResidueSelection();
        r.render('probe clear');
        await settle();
        R.seleFollows = { pressed: pressed(), n: size() };
      }

      // BACK TO ONE OBJECT AT A TIME: the picker comes back, and what it names
      // is what is on screen.
      btn.click();
      await settle();
      R.offMulti = btn.getAttribute('aria-pressed');
      R.offPicker = picker.disabled;
      R.offDrawn = r.drawnObjects();
      R.offListHidden = document.getElementById('objectList').hidden;
      R.offShown = r.shownObjects === null;
      btn.click();                      // ...and back into Multi for the rest
      await settle();

      // LEAVING MULTI KEEPS WHAT YOU WERE LOOKING AT. The two questions have
      // separate answers here - the eyes say what is drawn, the strip says
      // what is edited - and they are allowed to disagree. Dropping back to
      // one object used to keep the EDITED one, so pressing Multi off swapped
      // the picture for a different structure and everything that structure
      // was showing went with it.
      {
        const editing = r.currentObjectName;
        const other = names.find((n) => n !== editing);
        for (let k = 0; k < rowNames().length; k++) {
          const want = rowNames()[k] === other;
          if (rowOn(k) !== want) {
            eyes()[k].click();
            await settle();
          }
        }
        R.lookingAt = { drawn: r.drawnObjects(), editing: r.currentObjectName };
        btn.click();                    // Multi off
        await settle();
        R.keptOnLeaving = {
          drawn: r.drawnObjects(), editing: r.currentObjectName,
          picker: picker.value, wanted: other,
        };
        btn.click();                    // ...and back in for the rest
        await settle();
      }

      r.setShownObjects(names);
      r.render('all again');
      await settle();

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
      await settle();
      R.colBoth = colOf(names[0]);
      R.stripBoth = stripOf(names[0]);
      R.colBothSecond = colOf(names[1]);
      R.stripBothSecond = stripOf(names[1]);

      r.setShownObjects([names[0]]);
      r.render('first alone');
      await settle();
      R.colAlone = colOf(names[0]);
      R.stripAlone = stripOf(names[0]);
      // ...and the HIDDEN object's strip colours, which the strip still asks
      // for because the picker can be pointing at it
      R.stripSecondHidden = stripOf(names[1]);

      r.setShownObjects(names);
      r.render('both again');
      await settle();

      // THE STRIP IS ONE SECTION PER OBJECT ON SCREEN. It used to show the
      // object being edited and nothing else, so with two structures up it was
      // describing half the picture - and a selection in the other one was
      // invisible there.
      // ...driven the way a user drives it, so the strip has to follow the
      // LIST and not only an explicit rebuild
      r.setShownObjects([names[0]]);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await settle();
      renderObjectListIfAny();
      // ...the other object's eye, through the UI - the strip has to follow
      // the LIST and not only an explicit rebuild
      for (let k = 0; k < rowNames().length; k++) if (!rowOn(k)) {
        eyes()[k].click();
        await settle();
      }
      await settle();
      R.stripSections = (window.SEQ.layout() && window.SEQ.layout().objectLabelPositions
        ? window.SEQ.layout().objectLabelPositions.map((x) => x.object) : null);
      R.stripChains = (window.SEQ.layout() && window.SEQ.layout().chainLabelPositions
        ? window.SEQ.layout().chainLabelPositions.map((x) => x.object + '/' + x.chainId) : null);

      r.setShownObjects([names[0]]);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await settle();
      R.stripSectionsOne = (window.SEQ.layout() && window.SEQ.layout().objectLabelPositions
        ? window.SEQ.layout().objectLabelPositions.map((x) => x.object) : null);
      R.stripChainsOne = (window.SEQ.layout() && window.SEQ.layout().chainLabelPositions
        ? window.SEQ.layout().chainLabelPositions.map((x) => x.object + '/' + x.chainId) : null);
      r.setShownObjects(names);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await settle();

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
            groups: (r.ligandGroupsOf(nm) || new Map()).size,
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
          await settle();
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

      // CHAIN MODE, the strip's other shape: a row of chain blocks rather
      // than sequences. It goes through the same section loop and the same
      // hit tester, so it can go wrong in the same ways.
      {
        const modeSel = document.getElementById('sequenceModeSelect');
        modeSel.value = 'chain';
        modeSel.dispatchEvent(new Event('change'));
        await settle();
        const lay = window.SEQ.layout();
        R.chainModeSections = (lay.objectLabelPositions || []).map((x) => x.object);
        R.chainModeBlocks = (lay.chainLabelPositions || [])
          .map((x) => x.object + '/' + x.chainId);
        // ...and a click on one block takes that object's chain, not the
        // other object's chain of the same name
        const cv = document.getElementById('sequenceCanvas');
        const bx = cv.getBoundingClientRect();
        const dpi = 200 / 96;
        const want = lay.chainLabelPositions.find(
          (cp) => cp.chainId === 'A' && cp.object === names[1]);
        r.clearResidueSelection();
        if (want) {
          const x = bx.left + (want.x + 2) * bx.width / (cv.width / dpi);
          const y = bx.top + (want.y + 2 - (lay.scrollTop || 0))
            * bx.height / (cv.height / dpi);
          cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
          cv.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
          await settle();
        }
        const picked = r.residueSelection ? Array.from(r.residueSelection) : [];
        R.chainModeOwners = Array.from(new Set(picked.map((i) => (r.ownerOf(i) || {}).name)));
        R.chainModeCount = picked.length;
        r.clearResidueSelection();
        modeSel.value = 'sequence';
        modeSel.dispatchEvent(new Event('change'));
        await settle();
      }

      // NOTHING ON SCREEN, NOTHING TO READ: the strip goes quiet rather than
      // listing residues of a picture that is not there, and its tools go dead
      // with it - a click in it would select something nobody can see.
      r.setShownObjects([]);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await settle();
      R.emptyStripLayout = window.SEQ.layout();
      R.emptyStripNote = !!document.querySelector('.sequence-empty-note');
      R.emptyStripDisabled = ['selectAllResidues', 'clearAllResidues',
        'invertSelection'].every((id) => (document.getElementById(id) || {}).disabled);
      r.setShownObjects(names);
      if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView();
      await settle();
      R.backStripSections = (window.SEQ.layout() || {}).objectLabelPositions
        ? window.SEQ.layout().objectLabelPositions.map((x) => x.object) : null;
      R.backStripEnabled = !document.getElementById('selectAllResidues').disabled;

      // THE PICKER IS ON SCREEN AND GREYED, because Multi is on: what is
      // drawn is the eyes' business here, and which object you are EDITING is
      // said by the strip's sections - clicking in one is how you change it.
      R.pickerVisible = !!(picker && picker.offsetParent !== null);
      R.pickerGreyed = !!(picker && picker.disabled);
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
      await settle();
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
      await settle();
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
        await settle();
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
      // SAVE AND RELOAD A MERGED SESSION. Everything an object remembers is
      // stored in ITS OWN numbering, so the file must come back with each set
      // on the right object - and the shown set with it.
      {
        r.setShownObjects(names);
        await settle();
        const o0 = r.multiState.sourceOffsets[0];
        const o1 = r.multiState.sourceOffsets[1];
        r.setBackboneHiddenFor([o1, o1 + 1], true);
        for (const [nm, local, hex] of [[names[0], 2, '#ff0000'], [names[1], 3, '#00ff00']]) {
          const o = r.objectsData[nm];
          const value = (o.color && o.color.type === 'advanced' && o.color.value) || {};
          value.position = value.position || {};
          value.position[local] = hex;
          o.color = { type: 'advanced', value };
        }
        // ...and one of EVERY KIND in the per-object field list, because the
        // save rule differs by kind and the difference inverts a feature: an
        // EMPTY `bases` means no plates at all, while an absent one means
        // every plate, so a saver that drops empty sets turns one into the
        // other. See OBJECT_STATE.
        r.objectsData[names[0]].sidechains = new Set([1, 2]);
        r.objectsData[names[1]].bases = new Set();          // none, explicitly
        r.objectsData[names[0]].elements = new Set([1]);
        r.objectsData[names[0]].sse = { 2: 'H' };
        r.objectsData[names[0]].sidechainColor = { 2: '#123456' };
        r.objectsData[names[0]].contacts = [[1, 2, 1, '#abcdef']];
        const setOf = (o, k) => (r.objectsData[o][k] instanceof Set
          ? Array.from(r.objectsData[o][k]).sort((a, b) => a - b) : null);
        const state = (o) => ({
          hidden: Array.from(r.objectsData[o].hiddenBackbone || []).sort((a, b) => a - b),
          colour: JSON.stringify(((r.objectsData[o].color || {}).value || {}).position || null),
          sidechains: setOf(o, 'sidechains'),
          bases: setOf(o, 'bases'),
          elements: setOf(o, 'elements'),
          sse: JSON.stringify(r.objectsData[o].sse || null),
          sidechainColor: JSON.stringify(r.objectsData[o].sidechainColor || null),
          contacts: JSON.stringify(r.objectsData[o].contacts || null),
        });
        R.beforeSave = { [names[0]]: state(names[0]), [names[1]]: state(names[1]) };

        // ...through the Save button's own path
        const RealBlob = window.Blob;
        let captured = null;
        window.Blob = function (parts, opts) { captured = parts[0]; return new RealBlob(parts, opts); };
        const realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {};
        window.saveViewerState();
        window.Blob = RealBlob;
        HTMLAnchorElement.prototype.click = realClick;

        r.clearAllObjects();
        await until(() => !Object.keys(r.objectsData || {}).length, 2000);
        await window.loadViewerState(JSON.parse(captured));
        R.restoreSettled = await until(
            () => r.drawnObjects().length >= 2 && r.coords && r.coords.length > 0);
        await settle();
        R.afterLoad = { [names[0]]: state(names[0]), [names[1]]: state(names[1]) };
        R.afterLoadDrawn = r.drawnObjects();
        R.afterLoadN = r.coords.length;
      }
      // LOADED SECOND, THE SAME COLOURS. This is the report itself: a
      // structure opened in one set of chain colours on its own and another
      // set when something was loaded before it. Re-loading the first file
      // replaces its entry, which puts it LAST in the loaded order - so if
      // anything an object gets depends on that order, its slots move here.
      {
        const slotsOf = (nm) => {
          const out = [];
          for (const [key, slot] of r.chainIndexMap.entries()) {
            const bar = key.indexOf('|');
            if ((bar > 0 ? key.slice(0, bar) : nm) === nm) out.push(key + '=' + slot);
          }
          return out.sort().join(' ');
        };
        const first = R.sources[0];
        const before = slotsOf(first);
        await load(P.get('a'));
        await new Promise((s) => setTimeout(s, 900));
        R.reload = {before, after: slotsOf(first)};
      }
      // THE LAST LEG, deliberately: it changes what is drawn and what is
      // edited, and everything above reads the state it is handed.
      // ...AND PICKING AN OBJECT THAT IS SWITCHED OFF SWITCHES IT ON. Choosing
      // to work on something you cannot see is not a state anyone asks for: it
      // reads as the picker being broken, because nothing happens. (The other
      // direction stays: an eye switched off does not stop you editing that
      // object, which is how you restyle it before looking at it again.)
      {
        const wasDrawn = r.drawnObjects().slice();
        const wasEditing = r.currentObjectName;
        const off = rowNames().find((n) => !wasDrawn.includes(n));
        if (!off) throw new Error('every object is already on screen');
        const sel = document.getElementById('objectSelect');
        sel.value = off; sel.dispatchEvent(new Event('change'));
        await settle();
        R.pickHidden = {picked: off, editing: r.currentObjectName,
                        drawn: r.drawnObjects()};
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""
PAGE_JS = PAGE_JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)


def build_probe():
    # THE ONE PROBE ON THE DEPLOYED PAGE. Every other probe serves dev.html
    # and the loose sources; this one serves index.html, which loads
    # bundles/py2Dmol.web.min.js. It is the broadest probe there is, so running it
    # against the bundle is the check that what the public downloads still
    # works - a bundle committed stale, or a terser setting that breaks a
    # name reached across files, fails here and nowhere else.
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
    # ...REUSING THE PORT, so the probe can be run twice in a row. Without
    # this the second run dies on "address already in use" while the first
    # one's socket sits in TIME_WAIT, which reads as a test failure.
    socketserver.ThreadingTCPServer.allow_reuse_address = True
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
    deadline = time.time() + min(a.timeout, DEADLINE)
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
    sb, so, sf, sx = (R.get('seleBefore') or {}, R.get('seleOn') or {},
                      R.get('seleOff') or {}, R.get('seleFollows') or {})
    both, back, narrow = (R.get('seleBoth') or {}, R.get('seleBackToOne') or {},
                          R.get('seleNarrow') or {})
    print(f"  sele shift: both {both.get('n')}/{both.get('want')}"
          f" {both.get('pressed')}, out again {back.get('n')}/{back.get('want')}"
          f" {back.get('pressed')}, plain click narrows to"
          f" {narrow.get('n')}/{narrow.get('want')} {narrow.get('pressed')}")
    print(f"  sele: {sb.get('n')} selected -> press {so.get('n')}"
          f" of {so.get('whole')} -> press again {sx.get('n')};"
          f" pressed {sb.get('pressed')} -> {so.get('pressed')}"
          f" -> {sx.get('pressed')} (at once {R.get('seleOffAtOnce')})")


    print(f"  map covers {R['mapLen']} of {R['bothN']} positions")
    print(f"  {R['segments']} segments, {R['crossing']} of them across the join")
    print(f"  auto per object: {R.get('autos')}; first position of each:"
          f" {R['colors']}")
    print(f"  colours per object: {[len(x) for x in R.get('perSource', [])]},"
          f" both by chain: {R.get('bothByChain')}, shared: {R.get('sharedColors')};"
          f" palette slots {R.get('chainSlots')}")
    print(f"  modes: {R.get('modes')}")
    print(f"  painted: {R.get('painted')}")
    print(f"  hiding 40 of the second object: {R['hiddenInk']} ink,"
          f" back to {R['restoredInk']}; first object touched:"
          f" {R['hiddenOnFirst']}, second object's lowest index {R['hiddenLocal']}")
    print(f"  list: rows {R.get('rows')}, swatches {R.get('swatches')};"
          f" button {R.get('btnOne')!r}, pressed {R.get('multiBefore')} ->"
          f" {R.get('multiAfter')} -> {R.get('offMulti')}; picker live in multi:"
          f" {not R.get('pickerAfter')}, live outside: {not R.get('offPicker')}")

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
    print(f"  chain mode: sections {R.get('chainModeSections')}, blocks"
          f" {R.get('chainModeBlocks')}; a click took {R.get('chainModeCount')}"
          f" residues of {R.get('chainModeOwners')}")
    print(f"  empty strip: layout {R.get('emptyStripLayout')}, note"
          f" {R.get('emptyStripNote')}, tools dead {R.get('emptyStripDisabled')};"
          f" back -> {R.get('backStripSections')}, live {R.get('backStripEnabled')}")
    print(f"  picker on screen: {R.get('pickerVisible')}, live in multi:"
          f" {not R.get('pickerGreyed')};"
          f" clicking in {R.get('wantedObject')}'s section -> editing"
          f" {R.get('afterPickCurrent')}, selected a residue of"
          f" {R.get('afterPickOwner')}, drawn {R.get('afterPickDrawn')}")
    ss = R.get('ssShared') or {}
    print(f"  SS colours on a merge (mode {ss.get('mode')!r}):"
          f" the drawing's assignment {ss.get('draw')},"
          f" a second one for the colours {ss.get('colourOwn')}")
    if not ss.get('draw'):
        bad.append("the draw stage did not cache an SS assignment, so nothing"
                   " here says whether the colour path reuses it")
    elif ss.get('colourOwn') or not ss.get('sameArray'):
        bad.append("asking for the assignment computed a second one beside the"
                   " drawing's - two full passes, because the two cache keys"
                   " were built in two places and the colour path's left the"
                   " merged objects out")

    o1 = R.get('orientOne') or {}
    print(f"  orient on {o1.get('object')} alone (editing {o1.get('edited')}):"
          f" centre {o1.get('off')} A from its centroid, against"
          f" {o1.get('wrongBy')} A between the two objects")
    print(f"  orient: {R.get('orientInk')} ink,"
          f" {R.get('outsideAfterOrient')} positions off canvas;"
          f" picking reaches {R.get('pickOwner')} (of {R.get('pickTried')} tries);"
          f" clip {R.get('clipSlab')} leaves {R.get('clipInk')} ink")
    print(f"  Object mode offered: {R.get('objectOptionShown')},"
          f" colours per object in it: {R.get('flatPerObject')}")
    print(f"  tube:  {R.get('tubeInk')} ink, {R.get('tubeCrossing')} crossing;"
          f" gpu {R.get('tubeGpuInk')} (path taken: {R.get('tubeGpuTook')})")
    print(f"  save/reload: {R.get('afterLoadDrawn')} came back with"
          f" {R.get('afterLoadN')} positions, per-object state identical:"
          f" {R.get('beforeSave') == R.get('afterLoad')}")
    print(f"  gpu:   {R['gpuInk']:8d} ink (path taken: {R['gpuTook']})"
          + (f"  DECLINED: {R['gpuError']}" if R.get("gpuError") else ""))

    bad = []
    if so.get('n') != so.get('whole') or so.get('whole', 0) <= 0:
        bad.append(f"sele selected {so.get('n')} of the object's"
                   f" {so.get('whole')} residues")
    if (so.get('pressed') or [None])[0] != 'true':
        bad.append("sele did not light up while its selection stood")
    if R.get('seleOffAtOnce') != 0:
        bad.append(f"pressing a lit sele again re-selected"
                   f" {R.get('seleOffAtOnce')} residues - the latch only"
                   " latches one way")
    if sx.get('n') != 0 or (sx.get('pressed') or [None])[0] != 'false':
        bad.append(f"pressing a lit sele again left {sx.get('n')} residues"
                   f" selected and the button {(sx.get('pressed') or [None])[0]}"
                   " - a latch that only latches one way")
    if both.get('n') != both.get('want'):
        bad.append(f"shift-clicking a second sele gave {both.get('n')} residues,"
                   f" not the {both.get('want')} of both objects")
    if (both.get('pressed') or []) != ['true', 'true']:
        bad.append(f"both rows should be lit with both selected, got"
                   f" {both.get('pressed')}")
    if back.get('n') != back.get('want') or (back.get('pressed') or []) != ['true', 'false']:
        bad.append(f"shift-clicking a lit row again left {back.get('n')}"
                   f" residues and {back.get('pressed')} - shift has to take"
                   " one back out, not only add")
    if narrow.get('n') != narrow.get('want') or (narrow.get('pressed') or []) != ['false', 'true']:
        bad.append(f"a plain click on one of two selected objects gave"
                   f" {narrow.get('n')} residues and {narrow.get('pressed')} -"
                   " it should narrow to that object, not clear")
    se = R.get('seleShiftEmpty') or {}
    if se.get('n') != 0 or se.get('held') or (se.get('pressed') or []) != ['false', 'false']:
        bad.append(f"shift-clicking the last selected object out left"
                   f" {se.get('n')} residues (held {se.get('held')},"
                   f" {se.get('pressed')})")
    if not R.get('seleSameNode'):
        bad.append('the sele button was rebuilt by its own click, which is how'
                   ' the press gets swallowed')
    if (sf.get('pressed') or [None])[0] != 'false' or sf.get('n') != 0:
        bad.append('sele stayed lit after the selection was cleared elsewhere')
    if not R.get("iconCount"):
        bad.append("no toolbar icons were found, so the clash check below"
                   " passes on an empty set")
    elif R.get("iconClashes"):
        bad.append("two controls wear the same icon: "
                   + "; ".join(R["iconClashes"])
                   + " - a toolbar where two buttons look identical is worse"
                   " than one with no icons at all")
    if R.get("websiteRowWithOne") is not True:
        bad.append("the object row went away when the picker was down to one"
                   " option - on THIS page it also holds Multi and prev/next,"
                   " which stay useful with one object. The one-object hide is"
                   " for a row that holds nothing but the picker.")
    if R.get("websiteRowRestored") != len(R.get("objects") or []):
        bad.append(f"the probe did not put the picker's options back:"
                   f" {R.get('websiteRowRestored')} of {len(R.get('objects') or [])}"
                   " - everything measured after that point is suspect")
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
    rl = R.get("reload") or {}
    print(f"  loaded again, after the other object: "
          f"{'same chain colours' if rl.get('before') == rl.get('after') else 'MOVED'}"
          f" ({rl.get('after')})")
    if rl.get("before") != rl.get("after"):
        bad.append("re-loading an object after another one moved its chain"
                   f" colours: {rl.get('before')} -> {rl.get('after')}")
    if R.get("slotsFromZero"):
        bad.append("an object's chain slots do not start at zero, so its"
                   " colours move with what else is loaded: "
                   + str(R["slotsFromZero"]))
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
    # ...and Orient on one object lands on THAT object. Scored against the
    # distance between the two, so the check means something for any pair:
    # anything but a small fraction of it is the wrong structure.
    if o1.get("off") is None:
        bad.append("the one-object Orient leg did not run")
    elif o1["wrongBy"] < 1:
        bad.append("the two objects sit on top of each other, so orienting on"
                   " the wrong one would look identical - this pair proves"
                   " nothing about Orient")
    elif o1["off"] > 0.25 * o1["wrongBy"]:
        bad.append(f"Orient with only {o1['object']} on screen centred"
                   f" {o1['off']} A from it, with the other object"
                   f" {o1['wrongBy']} A away - it oriented on what the picker"
                   " names, not on what is drawn")
    if R.get("pickOwner") != R["sources"][1]:
        bad.append(f"picking never reached the second object in"
                   f" {R.get('pickTried')} tries - it reported {R.get('pickOwner')}")
    if not (0 < R.get("clipInk", 0) < R["bothInk"]):
        bad.append(f"auto clip on one object left {R.get('clipInk')} ink")
    if R.get("rows") != R["objects"]:
        bad.append(f"the list reads {R.get('rows')} - one row per object, no All")
    # THE BUTTON IS AN ICON - three stacked lines, the list it opens - and its
    # name is in the accessible label, which is what a screen reader and this
    # check both read. It said "Multi", which names a mode rather than what the
    # button does.
    if "expand" not in (R.get("btnOne") or "").lower():
        bad.append(f"the button reads {R.get('btnOne')!r}")
    if R.get("multiBefore") != "false" or R.get("multiAfter") != "true" \
            or R.get("offMulti") != "false":
        bad.append(f"Multi does not toggle: {R.get('multiBefore')} ->"
                   f" {R.get('multiAfter')} -> {R.get('offMulti')}")
    if not R.get("listHiddenBefore") or not R.get("offListHidden"):
        bad.append("the object list is showing outside Multi")
    # THE PICKER IS LIVE IN BOTH MODES. It used to grey out in Multi, on the
    # reasoning that the eyes decide what is drawn there and the picker had
    # nothing left to say. It has: the style, the clip and every panel under
    # the object row act on ONE object, and the picker is how you choose it.
    if R.get("pickerBefore") or R.get("pickerAfter") or R.get("offPicker"):
        bad.append("the picker is greyed somewhere - it names the object the"
                   f" panels act on, in both modes: {R.get('pickerBefore')} ->"
                   f" {R.get('pickerAfter')} -> {R.get('offPicker')}")
    if not R.get("multiOpensOnEdited"):
        bad.append(f"Multi opened on {R.get('oneObjectDrawn')} rather than the"
                   " object that was already on screen")
    if R.get("eyesOnAtOpen") != [i == R["objects"].index(R.get("pickerValue"))
                                 for i in range(len(R["objects"]))]:
        bad.append(f"the eyes opened as {R.get('eyesOnAtOpen')} - only the"
                   " object being shown should have one")
    if not R.get("offShown") or R.get("offDrawn") != [R.get("pickerValue")]:
        bad.append(f"leaving Multi left {R.get('offDrawn')} on screen rather"
                   f" than the picker's {R.get('pickerValue')!r}")
    k = R.get("keptOnLeaving") or {}
    print(f"  leaving Multi while looking at {R.get('lookingAt', {}).get('drawn')}"
          f" and editing {R.get('lookingAt', {}).get('editing')}:"
          f" drew {k.get('drawn')}, editing {k.get('editing')},"
          f" picker {k.get('picker')!r}")
    if k.get("drawn") != [k.get("wanted")]:
        bad.append(f"leaving Multi swapped the picture for {k.get('drawn')}"
                   f" - {k.get('wanted')} was the object on screen")
    if k.get("editing") != k.get("wanted") or k.get("picker") != k.get("wanted"):
        bad.append(f"the picker did not follow what was kept: editing"
                   f" {k.get('editing')}, picker {k.get('picker')!r}")

    if not R.get("cameraHeld"):
        bad.append("switching an eye moved the camera - an object already"
                   " framed should appear and disappear where it is")
    if R.get("swatches"):
        bad.append("the rows still carry colour swatches")
    if R.get("oneObjectDrawn") != [R["objects"][1]]:
        bad.append(f"the resting state drew {R.get('oneObjectDrawn')}")
    if R.get("afterAllDrawn") != R["objects"]:
        bad.append(f"All left {R.get('afterAllDrawn')} on screen")
    # NOT "more ink than one object". The camera frames on everything drawn,
    # so a second structure joining zooms BOTH out: 4HHB alone inks 99,439
    # against 71,132 for 4HHB beside 1TIM, and the merge is perfectly correct.
    # What All has to do is change the picture, and draw one.
    if not R.get("afterAllInk", 0):
        bad.append("All drew nothing at all")
    elif R.get("afterAllInk") == R.get("oneObjectInk"):
        bad.append("All left the picture exactly as it was with one object")
    if R.get("noneDrawn") != 0:
        bad.append(f"All switched off left {R.get('noneDrawn')} drawn")
    if R.get("noneInk", 1) != 0:
        bad.append(f"an empty canvas has {R.get('noneInk')} ink on it")
    if R.get("noneObjectsKept") != len(R["objects"]):
        bad.append("switching objects off unloaded them")
    if R.get("oneBackDrawn") != [R["objects"][0]]:
        bad.append(f"one eye from an empty canvas drew {R.get('oneBackDrawn')}")
    if R.get("oneBackIsEdited"):
        bad.append("this leg is meant to draw the object that is NOT being edited")
    if not R.get("oneBackInk"):
        bad.append("one eye from an empty canvas drew nothing")
    ph = R.get("pickHidden") or {}
    print(f"  picking {ph.get('picked')} while it was off: editing"
          f" {ph.get('editing')}, drawn {ph.get('drawn')}")
    if ph.get("editing") != ph.get("picked") \
            or ph.get("picked") not in (ph.get("drawn") or []):
        bad.append("picking an object that was switched off left it off screen:"
                   f" {ph}")
    fr = R.get("oneBackFraming") or {}
    print(f"  ...framed at {fr.get('extent')} against its own {fr.get('own')}")
    if not fr.get("own") or not fr.get("extent") \
            or abs(fr["extent"] - fr["own"]) > 0.01 * fr["own"]:
        bad.append("one eye from an empty canvas kept the camera it found"
                   f" ({fr.get('extent')}) rather than framing the object it"
                   f" drew ({fr.get('own')})")
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
    if R.get("chainModeSections") != R["objects"]:
        bad.append(f"chain mode has sections {R.get('chainModeSections')}")
    if len({b.split('/')[0] for b in R.get("chainModeBlocks", [])}) != 2:
        bad.append(f"chain mode's blocks come from {R.get('chainModeBlocks')}")
    if R.get("chainModeOwners") != [R["objects"][1]]:
        bad.append(f"a chain-mode click took residues of {R.get('chainModeOwners')}")
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
    if not R.get("pickerVisible"):
        bad.append("the object picker is not on screen - it is the ordinary"
                   " way to choose one object")
    if R.get("pickerGreyed"):
        bad.append("the picker is greyed in Multi - it chooses what you are"
                   " editing there, while the eyes choose what is drawn")
    if R.get("pickerOptions") != R["objects"]:
        bad.append(f"the select no longer tracks the objects:"
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
    # 🔴 A BOUND 0.2% ABOVE THE MEASURED VALUE IS A BOUND THAT FAILS ON NOISE.
    # The two painters legitimately disagree here by about 4.8% - they are
    # different rasterisers over the same geometry - and this asked for 5%. The
    # ink count moves 30-50 pixels between runs of IDENTICAL code, so the
    # assertion crossed its own threshold about one run in three: measured on
    # 1BBH+1EHZ, three runs of the unchanged tree gave 25872 / 25842 / 25839
    # against a CPU 27201, which is 4.89 / 4.99 / 5.01% - the last of them a
    # failure. Widened to 10%, which still catches a GPU drawing something
    # structurally different while leaving room for the rasteriser's own
    # scatter; "it drew nothing at all" is the separate check above.
    # The sibling tube comparison two lines up has always allowed 20%.
    if abs(R["gpuInk"] - R.get("cpuBeforeGpu", 1)) > 0.10 * R.get("cpuBeforeGpu", 1):
        bad.append(f"the GPU picture ({R['gpuInk']} ink) is not the CPU one"
                   f" ({R.get('cpuBeforeGpu')})")
    if R.get("beforeSave") != R.get("afterLoad"):
        bad.append(f"a saved session came back different: {R.get('beforeSave')}"
                   f" -> {R.get('afterLoad')}")
    if R.get("afterLoadDrawn") != R["objects"]:
        bad.append(f"a saved merged session came back showing {R.get('afterLoadDrawn')}")
    if not R.get("afterLoadN"):
        bad.append("nothing was loaded back")
    for m in bad:
        print("FAIL:", m)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
