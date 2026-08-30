"""The embed bundle, in a browser, on a page that has nothing else.

    python3 tests/embed.py

WHAT THIS IS FOR. bundles/py2Dmol.embed.min.js was built and committed for months and
had never once run: it omitted parts/ui.js, so the first call died on
`wireViewerUI is not defined`, and nothing in the suite loaded it. Adding the
missing files would not have been enough either - wireViewerUI looks up
forty-two controls by id, and against a bare container the first
addEventListener throws on null.

So the artefact needs its own entry point, and an entry point needs a test that
uses it the way a stranger would: one script tag, one call, no markup but a
div. Anything this page needs that embed.html does not show is a bug in the
API, not in the page.

  * py2Dmol.show puts ink on the canvas from PDB text alone;
  * ...and from mmCIF text, sniffed rather than declared;
  * the six documented methods are all there and setStyle redraws;
  * a drag rotates - the gesture wiring is in the renderer, not the panel;
  * a second embed on the same page gets its OWN canvas, which is the trap in
    looking a canvas up by id;
  * the panel is NOT in the bundle - if it ever is, the embed has quietly
    become the app and the size claim in embed.html is wrong.
"""
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import DEADLINE  # noqa: E402

# ...and the runner waits longer than probe_js's shared deadline for the same
# reason: this is the widest probe in the suite.
DEADLINE = max(DEADLINE, 100)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_embed_probe.html')
PORT = 9677

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="one" style="width:320px;height:320px"></div>
<div id="two" style="width:200px;height:200px"></div>
<div id="three" style="width:200px;height:200px"></div>
<div id="four" style="width:200px;height:200px"></div>
<div id="five" style="width:200px;height:200px"></div>
<div id="six" style="width:240px;height:240px"></div>
<div id="seven" style="width:560px;height:320px"></div>
<div id="orient" style="width:240px;height:240px"></div>
<div id="orientoff" style="width:120px;height:120px"></div>
<div id="reload" style="width:120px;height:120px"></div>
<div id="bg3d" style="width:120px;height:120px"></div>
<div id="bg3dw" style="width:120px;height:120px"></div>
<div id="align" style="width:200px;height:200px"></div>
<div id="bare" style="width:200px;height:240px"></div>
<div id="withmenu" style="width:200px;height:260px"></div>
<div id="fitbox" style="width:420px;height:260px"></div>
<div id="narrowbox" style="width:210px"></div>
<div id="vis" style="width:200px;height:200px"></div>
<div id="sel" style="width:200px;height:200px"></div>
<div id="orient2" style="width:200px;height:200px"></div>
<div id="unify" style="width:220px;height:220px"></div>
<div id="selrel" style="width:180px;height:180px"></div>
<div id="bu" style="width:120px;height:120px"></div>
<div id="elem" style="width:220px;height:220px"></div>
<div id="schue" style="width:220px;height:220px"></div>
<div id="bu2" style="width:120px;height:120px"></div>
<div id="bu3" style="width:120px;height:120px"></div>
<div id="bu4" style="width:120px;height:120px"></div>
<div id="withplay" style="width:200px;height:260px"></div>
<div id="baremany" style="width:180px"></div>
<div id="bareone" style="width:180px"></div>
<div id="barerefused" style="width:180px"></div>
<iframe id="doc" src="/embed.html" style="width:1100px;height:900px;border:0"></iframe>
<script src="py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
const R = {errors: [], steps: []};
window.addEventListener('error', (e) => R.errors.push(String(e.message)));

const ink = (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
  }
  return n;
};
// TWO FRAMES, OR A TIMER IF THE FRAMES STOP COMING. requestAnimationFrame can
// stop firing in a headless window that is considered hidden, and an await that
// never resolves looks exactly like a crash with no error - which is how this
// test first failed.
// --- driving the published page ---------------------------------------------
const drivePage = async () => {
  const f = document.getElementById('doc');
  const out = {errors: [], viewers: {}, boxes: {}, label: null, waited: 0};
  // WAIT FOR THE PAGE, NOT FOR A NUMBER. A fixed sleep passed alone and failed
  // in the parallel lane, where eight viewers parsing structures at once take
  // longer than they do on an idle machine - and the failure read as "the page
  // has no viewers", which is what an unfinished iframe looks like.
  const ready = () => {
    const D = f.contentDocument;
    if (!D || D.readyState !== 'complete') return false;
    const boxes = [...D.querySelectorAll('.canvas-box')];
    if (!boxes.length) return false;
    // ...every one of them has a canvas with something on it
    return boxes.every((b) => {
      const c = b.querySelector('canvas');
      if (!c || !c.width) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) return true;
      }
      return false;
    });
  };
  for (; out.waited < 30000 && !ready(); out.waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const W = f.contentWindow, D = f.contentDocument;
  W.addEventListener('error', (e) => out.errors.push(String(e.message)));
  // ...INCLUDING THE ONES FROM BEFORE WE COULD LISTEN. This hook goes on after
  // the page reports loaded, so anything thrown while it was setting itself up
  // was invisible - and one dead line at the end of its script threw on every
  // load through a full green run. The page keeps its own list from its first
  // statement.
  for (const m of (W.__pageErrors || [])) out.errors.push('on load: ' + m);

  const sig = (id) => {
    const c = D.querySelector('#' + id + ' canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0, h = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) {
        ink++; h = (h * 31 + d[i] * 7 + d[i + 1] * 13 + d[i + 2] * 17) >>> 0;
      }
    }
    return {ink, h};
  };

  // EVERY viewer the page defines, found by looking rather than by a list here.
  for (const box of D.querySelectorAll('.canvas-box')) {
    const s = sig(box.id);
    out.viewers[box.id] = s ? s.ink : null;
  }
  // ...AND WHETHER THE PAGE'S OWN CSS HAS REACHED INTO THEM.
  //
  // Every selector in the shell is scoped so it cannot take a host page's
  // dropdowns, and for a long time nothing defended the other direction. This
  // page styles a bare button element - a 13px font, fatter padding, and a
  // margin of 0 .3rem .4rem 0 - which is an ordinary thing for a page to do.
  // The shell states height and padding so those held; MARGIN did not. Orient
  // and Clip are buttons and took 4.8px on the right and 6.4px underneath,
  // Rotate is a label and took none, so the row came out unevenly spaced and
  // the column 13px taller. An embed has to look the same in any page.
  out.strayMargins = [];
  out.rowGaps = [];
  out.colCount = D.querySelectorAll('#rightPanelContainer').length;
  out.btnRowCount = D.querySelectorAll('.btn-row').length;
  out.shellIds = [...D.querySelectorAll('[id]')].map(e => e.id)
    .filter(x => /right|btn-row|control/i.test(x)).slice(0, 6);
  for (const col of D.querySelectorAll('#rightPanelContainer')) {
    for (const c of col.querySelectorAll('button, select, input, label')) {
      const m = getComputedStyle(c).margin;
      if (m && m !== '0px') out.strayMargins.push((c.id || c.tagName) + ':' + m);
    }
    // ...and the two gaps a reader compares: between buttons in a row, and
    // between the rows. They are the same number in the sheet and must be the
    // same number on screen.
    const row = col.querySelector('.btn-row');
    const rows = [...col.querySelectorAll('.btn-row')];
    if (row && row.children.length > 1 && rows.length > 1) {
      const a = row.children[0].getBoundingClientRect();
      const b = row.children[1].getBoundingClientRect();
      const r0 = rows[0].getBoundingClientRect();
      const r1 = rows[1].getBoundingClientRect();
      out.rowGaps.push([Math.round(b.left - a.right), Math.round(r1.top - r0.bottom)]);
    }
  }

  // ON IS ON, HOWEVER THE BUTTON SPELLS IT. Clip latches (aria-pressed) and
  // Style and Capture open a panel (aria-expanded); to the reader all three
  // are "this is on" and they wear one skin. The shell's open cue named
  // #styleToggle, so Capture put its panel up with its button unlit - measured
  // as a COLOUR, because the attribute was already being set and the button
  // still looked off.
  out.cue = null;
  {
    const col = D.querySelector('#rightPanelContainer');
    const cap = col && col.querySelector('#saveImageButton');
    const sty = col && col.querySelector('#styleToggle');
    if (cap && sty) {
      const skin = (e) => getComputedStyle(e).backgroundColor;
      const closed = skin(cap);
      cap.click();
      const open = skin(cap);
      const expanded = cap.getAttribute('aria-expanded');
      cap.click();
      const reclosed = skin(cap);
      sty.click();
      const styleOpen = skin(sty);
      sty.click();
      out.cue = {closed, open, expanded, reclosed, styleOpen};
    }
  }

  // ...AND THE CODE EACH SECTION PRINTS. There are no button rows any more:
  // a section is one complete example, run once at load and displayed
  // verbatim beside itself. So the check is that the box filled and that what
  // it ran did not throw - the page marks a failed example with .err.
  for (const el of D.querySelectorAll('pre.ran')) {
    // ...AND WHETHER THE VIEWER ABOVE IT STAYS IN ITS BOX. A viewer with a
    // panel or a player is TALLER THAN ITS CANVAS, so a container with a fixed
    // height leaves the chrome lying over whatever comes next - which has now
    // happened twice, to the Style panel and to the frame strip. One check for
    // the shape rather than for either instance.
    const host = D.getElementById(el.id.replace('code', ''));
    let spill = null;
    if (host) {
      const inner = host.querySelector('#viewerWrapper') || host.querySelector('canvas');
      if (inner) {
        spill = Math.round(inner.getBoundingClientRect().bottom
                           - el.getBoundingClientRect().top);
      }
    }
    out.boxes[el.id] = {code: (el.textContent || '').trim(),
                        threw: /\berr\b/.test(el.className), spill};
  }
  // ...THE LIBRARY'S OWN COUNTER, not one the page keeps. The frames example
  // used to hand-roll a slider and a label; it asks for `play: true` now and
  // gets the notebook's strip, whose counter reads "1 / 6".
  const lab = D.querySelector('#v11 #frameCounter');
  out.label = lab ? lab.textContent : null;
  return out;
};

const frame = () => new Promise((r) => {
  let done = false;
  const fin = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => requestAnimationFrame(fin));
  setTimeout(fin, 250);
});
const canvasIn = (id) => document.getElementById(id).querySelector('#canvas');
// ...and wait for the ink rather than for a number of frames. The second
// viewer measured zero on a fixed two-frame wait while the first measured
// seventeen thousand, purely because the first had a setStyle and four more
// frames behind it. A poll with a ceiling still reports 0 for a viewer that
// genuinely draws nothing.
const inked = async (id, ms) => {
  const c = canvasIn(id);
  for (let waited = 0; waited < ms; waited += 60) {
    const n = ink(c);
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 60));
  }
  return ink(c);
};
// ...and WHAT was drawn, not how much of it. Ribbon and richardson cover
// almost the same area - 3,914 against 3,895 on a small canvas - so a pixel
// count cannot tell them apart, and a check that they differ has to look at
// the pixels themselves.
const shot = (id) => {
  const c = canvasIn(id);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4) {
    h = (h * 31 + d[i] * 7 + d[i + 1] * 13 + d[i + 2] * 17) >>> 0;
  }
  return h;
};

const finish = () => {
  if (finish.done) return;
  finish.done = true;
  navigator.sendBeacon('/result', JSON.stringify(R));
};
// A WATCHDOG, so a hang reports its last step rather than nothing. Generous,
// because this page drives its own eight viewers AND every live example on
// embed.html - eleven more - and a partial result reads as a broken feature:
// "no .canvas-box viewers found" is what an unfinished iframe looks like.
setTimeout(finish, 80000);

(async () => {
  try {
    R.steps.push('start');
    R.hasApi = typeof window.py2Dmol === 'object'
        && typeof window.py2Dmol.show === 'function';
    R.steps.push('api');

    const v = py2Dmol.show('one', PDB_TEXT);
    R.steps.push('shown');
    await frame();
    R.steps.push('framed');
    R.tubeInk = await inked('one', 3000);
    // EVERY METHOD THE PAGE PROMISES, checked against the object it promises
    // them on. The list is read out of embed.html, so documentation that names
    // something that does not exist is a failing test rather than a reader's
    // problem.
    // ...AND EVERYTHING THE SAMPLES SHOW. The <pre> blocks are the half of
    // this page a reader copies from, and nothing checked them: when the
    // ligand demo was rewritten to use one selector and the sample beside
    // it was not, the page displayed a call the running code no longer
    // made. A verb that is not on the viewer, or a key the grammar has
    // dropped, is exactly what a rename leaves behind in prose.
    R.sampleBadVerbs = SAMPLE_VERBS.filter((n) => typeof v[n] !== 'function');
    R.sampleBadKeys = (() => {
        // ...show() OPTIONS and colour components, which live in the same
        // {curly braces} as a selector and are not one.
        const known = new Set(['animate', 'controls', 'play', 'style', 'color',
            'name', 'width', 'height', 'bg', 'box', 'orient', 'select',
            'biounit', 'positions', 'r', 'g', 'b', 'rendering', 'display',
            'size']);
        const out = [];
        for (const k of SAMPLE_KEYS) {
            if (known.has(k)) continue;
            try { v.select({[k]: 'x'}); }
            catch (e) { if (/unknown selector key/.test(String(e))) out.push(k); }
        }
        v.unselect();
        return out;
    })();

    R.missingOnViewer = DOC_VIEWER.filter((n) => typeof v[n] !== 'function');
    R.missingOnApi = DOC_API.filter((n) => typeof window.py2Dmol[n] !== 'function');

    // ...and the values it offers as buttons really are accepted.
    R.styleResults = {};
    for (const st of ['tube', 'cartoon']) {
      v.setStyle(st);
      await frame();
      R.styleResults[st] = await inked('one', 3000);
    }
    // A PRESET THAT IS NOT REAL LEAVES THE LAST PICTURE ON THE CANVAS.
    // setPreset warns and returns for a name it does not know, so ink alone
    // says nothing - a made-up preset passed a pixel count of nine thousand
    // that the previous preset had drawn. So ask what it ended up on.
    R.presetResults = {};
    R.presetTook = {};
    for (const pr of DOC_PRESETS) {
      v.setStyle(pr);
      await frame();
      R.presetResults[pr] = await inked('one', 3000);
      R.presetTook[pr] = v.stylePreset === pr && v.style === 'cartoon';
    }

    v.setStyle('cartoon');
    await frame();
    R.cartoonInk = await inked('one', 3000);

    // ...a drag. The renderer owns its gestures; if they lived in the panel
    // this would move nothing.
    const before = ink(canvasIn('one'));
    const c = canvasIn('one');
    const at = (t, x, y) => c.dispatchEvent(new MouseEvent(t, {clientX: x,
        clientY: y, bubbles: true, buttons: 1}));
    at('mousedown', 100, 100);
    at('mousemove', 190, 140);
    window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    await frame();
    R.rotatedInk = ink(c);
    R.rotationChanged = R.rotatedInk !== before;

    // ...and mmCIF, sniffed. Same structure, so it must draw too.
    const v2 = py2Dmol.show('two', CIF_TEXT);
    await frame();
    R.cifInk = await inked('two', 3000);
    R.cifPositions = v2.objectsData && v2.objectsData.structure
        ? v2.objectsData.structure.totalPositions : null;
    R.twoCanvases = document.querySelectorAll('canvas').length;
    R.separate = canvasIn('one') !== canvasIn('two');

    // THE DEFAULT CARTOON IS RICHARDSON, AND MUST BE THE SAME RICHARDSON.
    //
    // A viewer built with style:'cartoon' reported stylePreset 'richardson' and
    // drew none of it - flat ribbons, no grain, the wrong highlight - because
    // every default in the constructor asks cartoonRichardson, which was set
    // from whether the config NAMED the preset while stylePreset defaulted to
    // it. Two spellings of the same question, disagreeing. Comparing the two
    // paths field by field is the only way that shows: each one alone looks
    // like a cartoon.
    const LOOK = (r) => ({preset: r.stylePreset, rich: r.cartoonRichardson,
        pencil: r.cartoonPencil, thickness: r.cartoonThickness,
        sheetFlat: r.cartoonSheetFlat, highlight: r.cartoonHighlight,
        shade: r.cartoonShade, tint: r.cartoonOutlineTint,
        width: r.lineWidth, detail: r.cartoonDetail, fade: r.cartoonFade,
        arrows: r.cartoonArrows, smooth: r.cartoonSmooth});
    // EVERY PRESET, BOTH WAYS IN. Built from the config against switched to
    // with setPreset - and the default (no preset named) against richardson,
    // which is what the default is supposed to be.
    R.presetPaths = {};
    const probe = document.getElementById('three');
    for (const [label, cfg, name] of [
        ['default', {style: 'cartoon'}, 'richardson'],
        ['richardson', {style: 'cartoon', preset: 'richardson'}, 'richardson'],
        ['ribbon', {style: 'cartoon', preset: 'ribbon'}, 'ribbon'],
        ['3d', {style: 'cartoon', preset: '3d'}, '3d'],
    ]) {
        const r = py2Dmol.show(probe, PDB_TEXT, cfg);
        await frame();
        const built = LOOK(r);
        r.setPreset(name);
        await frame();
        R.presetPaths[label] = {built, switched: LOOK(r), name};
    }

    // WALKING THE STYLES, IN AND OUT OF TUBE.
    //
    // Every cartoon name has to repaint from tube, and each has to be its own
    // picture. Two separate bugs hid here, both leaving the state right and the
    // canvas wrong: calling setPreset from tube skipped the whole arrival into
    // cartoon and left the tube on screen, and then setting stylePreset and
    // falling through hit _recallStyleSettings, which restores the REMEMBERED
    // preset and returns - so tube -> ribbon drew richardson while reporting
    // ribbon. Neither shows in a field; both show the moment you compare
    // pictures.
    R.walk = [];
    const walker = py2Dmol.show('five', PDB_TEXT, {style: 'richardson'});
    await frame();
    for (const name of ['tube', 'ribbon', 'tube', 'richardson', 'tube', '3d',
                        'cartoon']) {
        walker.setStyle(name);
        await frame();
        const n = await inked('five', 3000);
        R.walk.push({set: name, style: walker.style,
                     preset: walker.stylePreset, ink: n, shot: shot('five')});
    }

    // THE OPTIONAL CHROME. controls: a style and a colour dropdown; play: a
    // frame strip that the RENDERER shows or hides on whether there is more
    // than one frame. Both hand their elements to the renderer rather than
    // driving it, so a change made from code moves them too - which is the
    // whole reason not to hand-roll them.
    const chrome = (id) => {
        const box = document.getElementById(id);
        // ...the PANEL's selects. Opening the Capture panel adds its own
        // format dropdown to the box, and counting every select then read the
        // style dropdown as 'png'.
        const sels = [...box.querySelectorAll('#stylePanel select')];
        const btn = box.querySelector('button');
        const rows = [...box.children].filter((c) => c.tagName === 'DIV');
        return {selects: sels.map((x) => x.value),
                rows: rows.map((r) => getComputedStyle(r).display),
                btnShown: btn ? getComputedStyle(btn).display !== 'none' : null};
    };
    py2Dmol.show('bare', PDB_TEXT);
    await frame();
    R.chromeBare = chrome('bare');

    const withMenu = py2Dmol.show('withmenu', PDB_TEXT, {controls: true});
    await frame();
    R.chromeMenu = chrome('withmenu');
    // ...SAVE IS PART OF THE PANEL. viewer.html puts it beside Style, and the
    // first version of the shell simply left it out - controls:true claimed to
    // be the notebook's panel while missing one of its two buttons.
    const menuBox = document.getElementById('withmenu');
    R.hasSave = !!menuBox.querySelector('#saveImageButton');
    R.hasStyleBtn = !!menuBox.querySelector('#styleToggle');
    // THE WIDGET STAYS INSIDE THE BOX IT WAS GIVEN, and there are two ways out
    // of one. The Style panel is built closed and is 469px tall open - taller
    // than most viewers - so on a fixed-height container it hung out of the
    // BOTTOM and over whatever the host page had below (139px on embed.html's
    // own examples, which is how this was found). And the panel column is a
    // fixed 190px, so a container narrower than canvas-plus-panel pushed it out
    // of the SIDE. Clamp-and-scroll answers the first, wrapping the second.
    //
    // On an AUTO-height host the same max-height resolves to nothing and the
    // host grows instead, which is what embed.html's section 12 relies on.
    {
        const fit = document.getElementById('fitbox');
        py2Dmol.show('fitbox', PDB_TEXT, {controls: true, width: 200, height: 200});
        await frame();
        fit.querySelector('#styleToggle').click();
        await new Promise((r) => setTimeout(r, 500));
        const col = fit.querySelector('#rightPanelContainer');
        const h = fit.getBoundingClientRect();
        const p = col.getBoundingClientRect();
        R.panelOpenHeight = Math.round(p.height);
        R.panelSpillDown = Math.round(p.bottom - h.bottom);
        R.panelSpillRight = Math.round(p.right - h.right);
        R.panelScrolls = col.scrollHeight > col.clientHeight + 1;
        // ...and the narrow case wraps rather than sticking out sideways
        const narrow = document.getElementById('narrowbox');
        py2Dmol.show('narrowbox', PDB_TEXT, {controls: true, width: 180, height: 180});
        await frame();
        await new Promise((r) => setTimeout(r, 300));
        const nb = narrow.getBoundingClientRect();
        const ncol = narrow.querySelector('#rightPanelContainer').getBoundingClientRect();
        R.narrowSpillRight = Math.round(ncol.right - nb.right);
        R.narrowWrapped = ncol.top > nb.top + 1;
    }
    if (R.hasSave) {
        menuBox.querySelector('#saveImageButton').click();
        await new Promise((r) => setTimeout(r, 700));
        R.saveFormats = [...document.querySelectorAll('#saveFormatSelect option')]
            .map((o) => o.value);
        // ...and again in cartoon, where the GPU has no vector to hand back
        menuBox.querySelector('#saveImageButton').click();   // close
        withMenu.setStyle('richardson');
        await frame();
        menuBox.querySelector('#saveImageButton').click();   // reopen
        await new Promise((r) => setTimeout(r, 700));
        const fmts2 = [...document.querySelectorAll('#saveFormatSelect option')]
            .map((o) => o.value);
        R.cartoonFormats = fmts2;
        R.svgHiddenForCartoon = !fmts2.includes('svg');
        menuBox.querySelector('#saveImageButton').click();   // close again
        withMenu.setStyle('tube');
        await frame();
    }
    // ...a setStyle from code must move the dropdown, not empty it: assigning
    // the INTERNAL style ('cartoon') to a select listing the flat names left it
    // blank, and in the app a re-sync hid that a moment later.
    withMenu.setStyle('ribbon');
    await frame();
    R.chromeAfterCode = chrome('withmenu');

    // ...AND A TRAJECTORY SHOWS THE STRIP WITHOUT BEING ASKED - including
    // without controls, which is the point: `play` used to be opt-in, so an
    // NMR ensemble in a plain embed had six models and no way to reach five of
    // them. The caller had already handed over the file that says how many.
    const bareMany = py2Dmol.show('baremany', CIF_MANY);
    await frame();
    await new Promise((r) => setTimeout(r, 400));
    R.bareManyStrip = !!document.querySelector('#baremany #frameSlider');
    R.bareManyFrames = bareMany.objectsData.structure.frames.length;
    // ...and a single structure is still the bare canvas it was
    const bareOne = py2Dmol.show('bareone', PDB_TEXT);
    await frame();
    R.bareOneStrip = !!document.querySelector('#bareone #frameSlider');
    R.bareOneRefused = !!py2Dmol.show('barerefused', CIF_MANY, {play: false})
        && !document.querySelector('#barerefused #frameSlider');

    const many = py2Dmol.show('withplay', CIF_MANY, {controls: true});
    await frame();
    R.chromePlay = chrome('withplay');
    R.chromePlayFrames = many.objectsData.structure.frames.length;
    // TWO SEPARATE QUESTIONS, and only one of them is about a clock.
    //
    // Is the strip wired to the frames - setFrame must repaint - and does the
    // button drive playback state. Timing the animation instead ("press play,
    // wait 900ms, did it move") failed in the parallel lane whenever the timer
    // did not get a turn, which says nothing about the strip.
    const beforeFrame = shot('withplay');
    many.setFrame(1);
    await frame();
    await inked('withplay', 3000);
    R.chromeFrameMoved = shot('withplay') !== beforeFrame;
    many.togglePlay();
    R.chromePlaying = many.isPlaying === true;
    many.togglePlay();
    R.chromeStopped = many.isPlaying === false;

    // ...the panel must not have come along for the ride.
    // COLOUR ON PART OF A STRUCTURE, CONTACTS, AND TWO OBJECTS AT ONCE - the
    // three things embed.html documents beyond the basics, each checked by
    // whether the picture actually changed.
    const six = py2Dmol.show('six', PDB_TEXT, {style: 'richardson'});
    await frame();
    await inked('six', 3000);
    const c0 = shot('six');
    six.setColor('red', {range: [0, 20]});
    await frame();
    R.colourRange = shot('six') !== c0;
    const c1 = shot('six');
    six.setColor('blue', {chain: 'A'});
    await frame();
    R.colourChain = shot('six') !== c1;
    // ...and the two writes MERGE rather than replacing one another
    const spec = six.objectsData[six.currentObjectName].color;
    R.colourSpec = !!(spec && spec.type === 'advanced' && spec.value.position
                      && spec.value.chain);

    const c2 = shot('six');
    six.setContacts([[5, 60, 1.0], [10, 40, 0.4, {r: 255, g: 0, b: 0}]]);
    await frame();
    await new Promise((r) => setTimeout(r, 400));
    R.contactsDrawn = shot('six') !== c2;
    six.setContacts([]);
    await frame();
    await new Promise((r) => setTimeout(r, 400));
    R.contactsCleared = shot('six') === c2;

    // ...two structures in one viewer
    const seven = py2Dmol.show('seven', PDB_TEXT, {name: 'A'});
    await frame();
    await inked('seven', 3000);
    const s0 = shot('seven');
    seven.load(SHIFTED_TEXT, 'B');
    await frame();
    seven.showObjects(['A', 'B']);
    await frame();
    await new Promise((r) => setTimeout(r, 500));
    R.twoObjects = seven.drawnObjects ? seven.drawnObjects() : null;
    R.twoDrawn = shot('seven') !== s0;

    // ORIENT, BOTH WAYS IN. The API on a bare embed, and the button in the
    // shell - and the button is the half worth testing, because wireViewerUI
    // does NOT wire it. Orient is not in the notebook's markup at all; on the
    // website the tag is in index.html and app/main.js wires it, so an embed
    // that grew the button and forgot the listener would look complete and do
    // nothing. That is exactly how four of embed.html's buttons failed once.
    const rotOf = (v) => JSON.stringify(v.viewerState.rotation);
    const ov = py2Dmol.show('orient', PDB_TEXT);
    await frame();
    await inked('orient', 3000);
    // ...SHOW ORIENTS BY ITSELF, like every other entry point. It did not: the
    // orient in parts/ui.js is on the static-payload path that only viewer.py
    // feeds, so an embed came up at the identity - the deposited crystal frame.
    // The identity is the exact fingerprint of that bug.
    R.showOriented = rotOf(ov) !== JSON.stringify([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    // ...and it landed where orient() would put it, rather than merely somewhere
    const settled = rotOf(ov);
    ov.orient({animate: false});
    await frame();
    R.showOrientedBest = rotOf(ov) === settled;
    // ...opt out, for a file that is already in the frame the reader wants
    py2Dmol.show('orientoff', PDB_TEXT, {orient: false});
    await frame();
    R.orientOff = rotOf(window.py2dmol_viewers.orientoff.renderer)
        === JSON.stringify([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    // ...spin it somewhere unhelpful first. A viewer orients itself when the
    // first object lands, so orienting an untouched one is allowed to be a
    // no-op and would assert nothing.
    ov.viewerState.rotation = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
    ov.render('test');
    await frame();
    const spun = rotOf(ov);
    const spunShot = shot('orient');
    ov.orient({animate: false});
    await frame();
    await new Promise((r) => setTimeout(r, 300));
    R.orientMoved = rotOf(ov) !== spun;
    R.orientDrew = shot('orient') !== spunShot;
    // ...and it landed on the SAME view the automatic one picks, which is what
    // makes it "best view" rather than merely "a different view".
    const auto = rotOf(ov);
    ov.viewerState.rotation = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    ov.orient({animate: false});
    await frame();
    R.orientRepeatable = rotOf(ov) === auto;

    // LOAD REPLACES AN OBJECT AND ALWAYS HAS A NAME - the two things the
    // reference promises ("put another structure up, or replace the current
    // one") and neither of which the renderer's own calls do. addObject returns
    // early on an object that has frames and addFrame then APPENDS, so a second
    // structure under a name in use became frame 2 of a trajectory of two
    // unrelated molecules; and with no name at all it reached
    // addObject(undefined), which left currentObjectName falsy and sent
    // addFrame down its emergency branch to invent a third object called '0'.
    const rv = py2Dmol.show('reload', PDB_TEXT);
    await frame();
    rv.load(SHIFTED_TEXT);                       // no name: the current one
    await frame();
    R.reloadNames = Object.keys(rv.objectsData).sort();
    R.reloadFrames = rv.objectsData.structure
        ? rv.objectsData.structure.frames.length : null;

    // A LOOK CARRIES ITS PAGE, and the config path skipped it: 3d is solid
    // shaded geometry meant to be seen on black, and _applyLookBackground runs
    // from setStyle/setPreset only - which a viewer built from a config never
    // calls. viewer.py had already worked around this in Python.
    R.bg3dShow = py2Dmol.show('bg3d', PDB_TEXT, {style: '3d'}).backgroundColor;
    const bgw = py2Dmol.show('bg3dw', PDB_TEXT, {style: '3d', bg: 'white'});
    R.bg3dOverride = bgw.backgroundColor;
    await frame();
    // ...and again after leaving and coming back, which is the OTHER half.
    // backgroundColor is not in STYLE_SETTINGS - it belongs to the look, and
    // 'cartoon' holds three looks - so _recallStyleSettings cannot restore it
    // and setStyle's short-circuit returned without anyone doing so. The black
    // page was a first-visit-only effect, on the website dropdown as much as
    // here.
    const bgv = py2Dmol.show('bg3d', PDB_TEXT, {style: '3d'});
    await frame();
    bgv.setStyle('tube'); await frame();
    R.bgAfterTube = bgv.backgroundColor;
    bgv.setStyle('3d'); await frame();
    R.bg3dAgain = bgv.backgroundColor;

    // CLICKING PICKS. selectionEnabled is false in the renderer - the default
    // is the notebook's, whose page has nothing to show a selection with - and
    // an embed left at that default had a select() and an orient() that read a
    // selection the canvas could not make.
    R.selectionOn = ov.selectionEnabled === true;
    R.selectionOff = py2Dmol.show('orientoff', PDB_TEXT,
        {select: false}).selectionEnabled === false;
    // ...and a click really does reach it, through the renderer's own handler
    ov.unselect();
    await frame();
    const ocanvas = document.getElementById('orient').querySelector('#canvas');
    const obox = ocanvas.getBoundingClientRect();
    const ox = Math.round(obox.left + obox.width / 2);
    const oy = Math.round(obox.top + obox.height / 2);
    // ...MEASURED AGAINST THE FRAME IMMEDIATELY BEFORE THE CLICK, and nothing
    // else may happen in between. The halo used to arrive LATE - the pick
    // landed, the canvas kept the old picture, and the next rotate brought the
    // halo in with it - because setResidueSelection only dispatches an event
    // and in an embed nobody is listening. An earlier version of this check
    // compared against a shot from several steps back, so any difference at
    // all read as a repaint and it passed throughout.
    const beforeClick = shot('orient');
    for (const t of ['mousedown', 'mouseup']) {
        ocanvas.dispatchEvent(new MouseEvent(t,
            {clientX: ox, clientY: oy, bubbles: true, button: 0}));
        await frame();
    }
    await new Promise((r) => setTimeout(r, 300));
    R.clickPicked = ov.residueSelection ? ov.residueSelection.size : 0;
    R.clickPainted = shot('orient') !== beforeClick;
    // ...and the background clear comes back the same way, without a nudge
    const withHalo = shot('orient');
    for (const t of ['mousedown', 'mouseup']) {
        ocanvas.dispatchEvent(new MouseEvent(t,
            {clientX: Math.round(obox.left + 4), clientY: Math.round(obox.top + 4),
             bubbles: true, button: 0}));
        await frame();
    }
    await new Promise((r) => setTimeout(r, 300));
    R.clearedOnBackground = !ov.residueSelection
        || ov.residueSelection.size === 0;
    R.clearPainted = shot('orient') !== withHalo;

    // setVisibility NAMES WHAT STAYS, and embed.html said the opposite for as
    // long as it had a Reference: "Sets of what to hide". The picture changes
    // either way - chain B alone against everything-but-chain-B are both
    // different from the whole structure - so the demo button read "hide chain
    // B", drew chain B alone, and no check noticed. Pinned by COUNTING what is
    // left visible, which is the only reading that tells the two apart.
    {
        const vv = py2Dmol.show('vis', PDB_TEXT, {style: 'cartoon'});
        await frame();
        await inked('vis', 3000);
        const total = vv.coords.length;
        const half = [];
        for (let i = 0; i < Math.floor(total / 3); i++) half.push(i);
        vv.setVisibility({positions: new Set(half)});
        await frame();
        await new Promise((r) => setTimeout(r, 300));
        R.visKept = vv.visiblePositions ? vv.visiblePositions.size : null;
        R.visAsked = half.length;
        R.visTotal = total;
        // ...THE EMPTY-SET EDGE, which is not what it looks like. Under the
        // DEFAULT mode an empty positions set is read as "not set" and
        // normalised to every position - so this draws everything, not
        // nothing. hideAll() spells it with visibilityMode:'explicit', and
        // that is the only spelling that draws nothing.
        vv.setVisibility({positions: new Set()});
        await frame();
        await new Promise((r) => setTimeout(r, 300));
        R.visEmptyDefault = vv.visiblePositions === null
            ? total : vv.visiblePositions.size;
        vv.setVisibility({positions: new Set(), visibilityMode: 'explicit'});
        await frame();
        await new Promise((r) => setTimeout(r, 300));
        R.visEmptyExplicit = vv.visiblePositions === null
            ? total : vv.visiblePositions.size;
        vv.resetVisibility();
        await frame();
        await new Promise((r) => setTimeout(r, 300));
        // null is the resting state and means "everything"
        R.visReset = vv.visiblePositions === null ? total : vv.visiblePositions.size;
    }

    // ONE SELECTOR, EVERYWHERE. The same set of residues said five ways must
    // come out as the same set - that is the whole claim of the unification,
    // and the only way to check it is to compare the resolved sets rather than
    // the pictures.
    {
        const sv = py2Dmol.show('sel', PDB_TEXT, {style: 'cartoon'});
        await frame();
        await inked('sel', 3000);
        // ...CLEARED EACH TIME. select adds now, like show and hide, so asking
        // "what does this selector name" by selecting it has to start from
        // nothing or every answer includes the one before it.
        const got = (x) => {
            sv.unselect();
            sv.select(x);
            return sv.residueSelection ? [...sv.residueSelection].sort((a, b) => a - b) : [];
        };
        const n = sv.coords.length;
        const byChain = got('A');
        R.selSpellings = {
            string: byChain.length,
            chainKey: got({chain: 'A'}).length,
            chainList: got({chain: ['A']}).length,
            agree: JSON.stringify(got({chain: 'A'})) === JSON.stringify(byChain)
                && JSON.stringify(got({chain: ['A']})) === JSON.stringify(byChain),
        };
        R.selArray = JSON.stringify(got([3, 4, 5]));
        R.selRange = JSON.stringify(got({range: [3, 6]}));
        R.selSet = JSON.stringify(got(new Set([3, 4, 5])));
        // 🔴 POSITIONS ARE NOT RESIDUE NUMBERS. 1UBQ starts at residue 1, so
        // residue 1 is position 0 - one apart, both integers, and nothing can
        // tell you which you meant. The two must NOT come out equal here.
        R.selResidues = JSON.stringify(got({residues: [1, 2, 3]}));
        R.selPositions = JSON.stringify(got({positions: [1, 2, 3]}));
        // ...and the keys AND together
        R.selAnd = got({chain: 'A', residues: [1, 2]}).length;
        R.selAndMiss = got({chain: 'Z', residues: [1, 2]}).length;
        // hide IS RELATIVE, AND THAT IS THE WHOLE REASON IT EXISTS. Every
        // absolute answer can be written reset-then-hide; no absolute spelling
        // can express "and also take this away from whatever is already off".
        // From a clean viewer the two agree, which is exactly why the
        // difference is easy to miss.
        const nvis = () => (sv.visiblePositions === null
            ? sv.coords.length : sv.visiblePositions.size);
        sv.resetVisibility(); await frame();
        sv.hide({range: [0, 10]}); await frame();
        R.invCleanHide = nvis();
        sv.resetVisibility(); await frame();
        sv.resetVisibility(); sv.hide({range: [0, 10]}); await frame();
        R.invCleanAbs = nvis();
        // ...now with six already hidden
        sv.resetVisibility(); await frame();
        sv.hide({range: [70, 76]}); await frame();
        sv.hide({range: [0, 10]}); await frame();
        R.invDirtyHide = nvis();
        sv.resetVisibility(); await frame();
        sv.hide({range: [70, 76]}); await frame();
        sv.resetVisibility(); sv.hide({range: [0, 10]}); await frame();
        R.invDirtyAbs = nvis();
        // ..."draw only these" is the complement, which is what showOnly was
        sv.resetVisibility(); await frame();
        sv.hide({not: {range: [0, 10]}}); await frame();
        R.drawOnly = nvis();
        // ...{not} composes with the other keys rather than replacing them
        sv.resetVisibility(); await frame();
        R.notComposes = got({chain: 'A', not: {residues: [1, 2, 3]}}).length;
        R.notWhole = got({not: {range: [0, 10]}}).length;
        sv.unselect();

        // A TYPO MUST THROW, not select everything. {chian: 'B'} narrows
        // nothing, and for hide() that is the model disappearing.
        try { sv.select({chian: 'A'}); R.typoThrew = false; }
        catch (e) { R.typoThrew = /unknown selector key/.test(String(e)); }

        // THE THREE VERBS. hide really hides - which is the thing that was
        // backwards - and show puts back. There is no showOnly: {not} made it
        // sugar, so "draw only x" is reset then hide the complement, and that
        // composition is what is checked here.
        const vis = () => (sv.visiblePositions === null ? n : sv.visiblePositions.size);
        sv.unselect();
        sv.hide({range: [0, 10]});
        await frame();
        R.visAfterHide = vis();
        sv.show({range: [0, 10]});
        await frame();
        R.visAfterShow = vis();
        sv.resetVisibility();
        await frame();
        sv.hide({not: {range: [0, 10]}});
        await frame();
        R.visAfterShowOnly = vis();
        sv.resetVisibility();
        await frame();
        R.visAfterReset = vis();
        R.selTotal = n;
        // ...and setColor takes the same shorthands
        sv.resetVisibility();
        await frame();
        const beforeCol = shot('sel');
        sv.setColor('red', 'A');
        await frame();
        await new Promise((r) => setTimeout(r, 300));
        R.colourByChainString = shot('sel') !== beforeCol;
    }

    // ORIENT TAKES A SELECTOR, and the failure it replaces is the quiet kind:
    // it used to take options only, so v.orient({type: 'L'}) was an options
    // object with no recognised key and it framed WHATEVER WAS SELECTED. In
    // embed.html's ligand example that was the pocket around the ligand, which
    // looks close enough to a close-up on the ligand to pass a screenshot.
    //
    // So: select one end of the structure, orient on the OTHER end by
    // selector, and the camera must go where the selector said.
    {
        const ov2 = py2Dmol.show('orient2', PDB_TEXT, {style: 'cartoon'});
        await frame();
        await inked('orient2', 3000);
        const rotOf2 = (v) => JSON.stringify(v.viewerState.rotation);
        const n2 = ov2.coords.length;
        const head = {range: [0, Math.floor(n2 / 4)]};
        const tail = {range: [Math.floor(n2 * 3 / 4), n2]};
        ov2.select(head);
        await frame();
        ov2.orient(Object.assign({animate: false}, tail));
        await frame();
        const onTail = rotOf2(ov2);
        // ...and the same view reached with NO selection at all, which is what
        // proves the selector and not the selection decided it
        ov2.unselect();
        await frame();
        ov2.orient(Object.assign({animate: false}, tail));
        await frame();
        R.orientSelectorWins = rotOf2(ov2) === onTail;
        // ...and it is NOT the view the standing selection would have given
        ov2.select(head);
        await frame();
        ov2.orient({animate: false});
        await frame();
        R.orientDiffersFromSelection = rotOf2(ov2) !== onTail;
    }

    // ONE SELECTOR, EVERY VERB - which is the claim the whole grammar is for,
    // and embed.html's ligand section is supposed to demonstrate. It did not:
    // it defined a `pocket` and then used three DIFFERENT selections across
    // four calls, which reads as "each verb wants its own", the opposite of
    // the point. So: one object, handed to every verb that takes residues.
    {
        const uv = py2Dmol.show('unify', PDB_TEXT, {style: 'cartoon'});
        await frame();
        await inked('unify', 3000);
        const SEL = {chain: 'A', range: [0, 30]};
        const shots = {};
        uv.select(SEL); await frame();
        shots.select = shot('unify');
        uv.setColor('red', SEL); await frame();
        await new Promise((r) => setTimeout(r, 300));
        shots.colour = shot('unify');
        uv.orient(Object.assign({animate: false}, SEL)); await frame();
        shots.orient = shot('unify');
        // ...CLIP IS CHECKED BY ITS SLAB, NOT BY PIXELS. On a small structure
        // the slab around 31 of 76 residues covers the whole thing, so nothing
        // is cut and the picture is legitimately unchanged - the verb worked
        // and the check would have been asserting the structure's size.
        uv.clip(SEL); await frame();
        await new Promise((r) => setTimeout(r, 300));
        R.clipSetSlab = uv.clipSlabOn() === true;
        R.clipThickness = uv.clipSlabOn()
            ? Math.round(uv.clipNear - uv.clipFar) : null;
        R.clipVsExtent = Math.round(uv.viewerState.extent);
        uv.hide(SEL); await frame();
        await new Promise((r) => setTimeout(r, 300));
        shots.hide = shot('unify');
        R.unifyDistinct = new Set(Object.values(shots)).size;
        R.unifySteps = Object.keys(shots).length;
        R.unifyDupes = Object.keys(shots).filter((k, i, a) =>
            a.some((o, j) => j !== i && shots[o] === shots[k]));
        R.unifyAccepted = ['select', 'setColor', 'orient', 'clip', 'hide']
            .filter((m) => typeof uv[m] === 'function');
        // ...and the one verb that legitimately refuses this structure says
        // exactly why, rather than doing nothing. A C-alpha trace has no
        // side-chain atoms to grow.
        try { uv.showSidechains(SEL); R.sidechainThrew = false; }
        catch (e) { R.sidechainThrew = /no side-chain atoms/.test(String(e)); }
    }

    // select AND unselect ARE RELATIVE, like hide and show. select used to
    // replace, which left no way to extend a selection from code while the
    // canvas could - shift-click has always added to one.
    {
        const ev = py2Dmol.show('selrel', PDB_TEXT, {style: 'cartoon'});
        await frame();
        await inked('selrel', 3000);
        const n = () => (ev.residueSelection ? ev.residueSelection.size : 0);
        ev.unselect();
        ev.select({range: [0, 10]});
        R.selFirst = n();
        ev.select({range: [20, 25]});
        R.selAdded = n();                       // 10 + 5, not 5
        ev.unselect({range: [0, 3]});
        R.selRemoved = n();                     // ...less three
        ev.unselect();
        R.selCleared = n();
        // ...and with no argument a selector is everything, which is why
        // unselect() clears and needs no special case
        ev.select();
        R.selAll = n();
        R.selTotal = ev.coords.length;
        ev.unselect();
    }

    // BIOUNIT AND FETCH, the two ways a structure gets bigger or arrives at
    // all. parse.js has known how to build a biological assembly all along and
    // the embed never asked, so it drew the asymmetric unit - a fraction of the
    // real molecule for anything symmetric.
    // ...ON BY DEFAULT, so the plain call is the assembly and the option is
    // how you refuse it.
    const asmText = await (await fetch('/2OMF.cif')).text();
    R.buAsm = py2Dmol.show('bu', asmText).coords.length;
    R.buPlain = py2Dmol.show('bu2', asmText, {biounit: false}).coords.length;
    // ...and a file with no assembly records is unchanged either way
    R.buNone = py2Dmol.show('bu3', PDB_TEXT).coords.length;
    R.buNonePlain = py2Dmol.show('bu4', PDB_TEXT, {biounit: false}).coords.length;
    R.hasFetch = typeof py2Dmol.fetch === 'function';
    // ...the id rule, without going near the network
    R.fetchRejects = await py2Dmol.fetch('').then(() => false, () => true);

    // ELEMENT COLOURS ARE ON BY DEFAULT, and the structure has to carry the
    // symbols for that to mean anything. embed.html's own trypsin block did
    // not - every atom parsed as element "" - so the ligand and the pocket
    // side chains drew in one flat colour and the feature looked switched off
    // when it was working perfectly on nothing.
    {
        const ev = py2Dmol.show('elem', LIG_TEXT, {style: 'cartoon'});
        await frame();
        await inked('elem', 4000);
        const owners = [...(ev.elementOwners() || [])];
        R.elemOwners = owners.length;
        R.elemSample = owners.slice(0, 5).map((i) => ev.positionElements[i]);
        R.elemSymbols = [...new Set(owners.slice(0, 60)
            .map((i) => ev.positionElements[i]))].filter(Boolean).sort();
        const on = shot('elem');
        ev.hideElements({type: 'L'});
        await frame();
        await new Promise((r) => setTimeout(r, 500));
        R.elemHidden = shot('elem') !== on;
        ev.showElements({type: 'L'});
        await frame();
        await new Promise((r) => setTimeout(r, 500));
        R.elemRestored = shot('elem') === on;
    }

    // SIDE CHAINS CAN CARRY THEIR OWN COLOUR, AND ONLY THE SIDE CHAINS.
    //
    // obj.sidechainColor has existed since the selection panel was written and
    // src/app/selection.js was the only thing that could reach it - the embed
    // and the notebook had the storage and no door. setSidechainColor is the
    // renderer's verb, so all three get it, and it takes a colour MODE as
    // readily as a colour: 'hydrophobicity' over a backbone coloured by
    // anything else is two questions on one picture.
    //
    // MEASURED ON THE CANVAS, because everything about this is arithmetic that
    // agrees with the bug: the map can be written correctly, the flags set
    // correctly, and the colour never reach a pixel.
    {
        const sv = py2Dmol.show('schue', LIG_TEXT, {style: 'cartoon'});
        await frame();
        await inked('schue', 4000);
        const site = {near: {type: 'L'}};
        const bare = shot('schue');

        // ...WITH NOTHING DRAWN, IT DRAWS NOTHING. The map is keyed by residue
        // and only an atom that is on screen reads it, so this is the whole of
        // "side chains only" stated as a measurement rather than as a claim.
        sv.setSidechainColor('hydrophobicity');
        await frame();
        await new Promise((r) => setTimeout(r, 500));
        R.scColourInertWithNoSidechains = shot('schue') === bare;

        sv.showSidechains(site);
        await frame();
        await new Promise((r) => setTimeout(r, 500));
        const coloured = shot('schue');
        R.scColourSidechainsDrawn = coloured !== bare;

        // 🔴 THE COMPARISON IS AGAINST THE SAME SIDE CHAINS UNCOLOURED, NOT
        // against the bare backbone. Measuring `coloured !== bare` scores
        // showSidechains and says nothing about the colour: two mutations that
        // stopped the colour reaching a pixel altogether walked straight
        // through it, because the atoms had still appeared. Clearing the
        // colour with the same atoms on screen is the only pair that differs
        // in one thing - and it doubles as the check that unset means FOLLOW
        // THE RESIDUE, which is what makes this a second colour rather than a
        // replacement.
        sv.setSidechainColor(null);
        await frame();
        await new Promise((r) => setTimeout(r, 500));
        const plain = shot('schue');
        R.scColourDrew = plain !== coloured;

        sv.setSidechainColor('hydrophobicity');
        await frame();
        await new Promise((r) => setTimeout(r, 500));
        R.scColourRepeatable = shot('schue') === coloured;

        // ...a control, so none of the three comparisons above can be passing
        // on an empty canvas
        R.scColourInk = ink(canvasIn('schue'));
    }
    // KABSCH AS A FUNCTION. It has been in every bundle since the browser took
    // the viewing geometry over from numpy, and only addFrame could reach it -
    // frame to frame, on itself. Two structures of the same molecule rarely
    // have the same atom list, so the case that matters is fitting on the
    // atoms they SHARE and moving everything.
    {
        const rmsd = (A, B) => Math.sqrt(A.reduce((s, p, i) => s
            + (p[0] - B[i][0]) ** 2 + (p[1] - B[i][1]) ** 2
            + (p[2] - B[i][2]) ** 2, 0) / A.length);
        const A = [];
        for (let i = 0; i < 30; i++) A.push([Math.cos(i * .6) * 5, Math.sin(i * .6) * 5, i * 1.5]);
        const t = 0.9;
        const M = [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
        const B = A.map((p) => [p[0] * M[0][0] + p[1] * M[0][1] + p[2] * M[0][2] + 7,
            p[0] * M[1][0] + p[1] * M[1][1] + p[2] * M[1][2] - 3,
            p[0] * M[2][0] + p[1] * M[2][1] + p[2] * M[2][2] + 2]);
        R.spApart = rmsd(A, B);
        R.spWhole = rmsd(py2Dmol.superpose(B, A), A);
        const idx = [0, 5, 10, 15, 20, 25];
        R.spSubset = rmsd(py2Dmol.superpose(B, A, {from: idx, to: idx}), A);
        // ...an atom the reference does not have travels with the body, which
        // is the whole reason the fit takes a subset
        const plus = B.concat([[99, 99, 99]]);
        const out = py2Dmol.superpose(plus, A, {from: idx, to: idx});
        R.spExtraMoved = out.length === 31
            && out[30].some((v, k) => Math.abs(v - plus[30][k]) > 1e-6);
        R.spMobileUntouched = plus[0][0] === B[0][0];
        const err = (f) => { try { f(); return false; } catch (e) { return true; } };
        R.spRefuses = {
            mismatch: err(() => py2Dmol.superpose(B, A.slice(0, 5))),
            halfPair: err(() => py2Dmol.superpose(B, A, {from: idx})),
            unevenPair: err(() => py2Dmol.superpose(B, A, {from: idx, to: [0, 1]})),
            badIndex: err(() => py2Dmol.superpose(B, A, {from: [0, 1, 999], to: [0, 1, 2]})),
            tooFew: err(() => py2Dmol.superpose(B, A, {from: [0, 1], to: [0, 1]})),
        };
    }
    // REPLACING A FRAME RATHER THAN APPENDING ONE. The notebook's live path has
    // done this since it existed - pop, then addFrame - and only a
    // BroadcastChannel could reach it. It is what lets an embed ANIMATE a
    // structure: hand the intermediate conformations to the frame that is
    // already there and the play bar never learns about them.
    {
        const rv = py2Dmol.show('vis', PDB_TEXT);
        await frame();
        const objName = rv.currentObjectName;
        const framesOf = () => rv.objectsData[objName].frames;
        const base = framesOf()[0].coords[0].slice();
        rv.addFrame(py2Dmol.frameFromText(PDB_TEXT), objName);
        R.rfBefore = framesOf().length;
        // ...a frame whose coordinates are somewhere else entirely
        const moved = py2Dmol.frameFromText(PDB_TEXT);
        moved.coords = moved.coords.map((p) => [p[0] + 25, p[1], p[2]]);
        rv.replaceFrame(moved, objName);
        R.rfAfter = framesOf().length;
        R.rfSwapped = framesOf()[framesOf().length - 1].coords[0][0] - base[0];
        // ...and the frame BEFORE it is untouched, which is the difference
        // between replacing one and rewriting the trajectory
        R.rfNeighbourIntact = framesOf()[0].coords[0][0] === base[0];
        // ...twice more, to show the count is stable rather than merely equal
        rv.replaceFrame(moved, objName);
        rv.replaceFrame(moved, objName);
        R.rfStable = framesOf().length;
        R.rfRefusesUnknown = (() => {
            try { rv.replaceFrame(moved, 'nope'); return false; } catch (e) { return true; }
        })();
    }
    // 🔴 THE PROJECTION FOLLOWS THE CONFIG, and for a long time it could not.
    // `viewerState.ortho` was seeded from the ortho SLIDER in four places and
    // an embed has no slider, so it was always 1 - flat - whatever
    // rendering.ortho said. normalizeConfig carried the key and nothing read
    // it, while viewer.py's signature, embed.html and the config schema all
    // promised it worked.
    {
        const px = (id) => {
            const c = canvasIn(id);
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let h = 0;
            for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 7 + d[i + 1] * 13 + d[i + 2] * 17) >>> 0;
            return h;
        };
        const seen = [];
        for (const ortho of [1, 0.5, 0]) {
            const box = document.getElementById('vis');
            box.replaceChildren();
            const ov = py2Dmol.show(box, PDB_TEXT, {rendering: {ortho}});
            await frame();
            await inked('vis', 4000);
            await new Promise((r) => setTimeout(r, 400));
            seen.push({asked: ortho, got: ov.viewerState.ortho,
                focal: +(ov.viewerState.focalLength || 0).toFixed(1),
                shot: px('vis')});
        }
        R.ortho = seen;
        // ...three settings, three pictures. Reading back the field alone would
        // pass against a value that is stored and never projected with.
        R.orthoDistinct = new Set(seen.map((s) => s.shot)).size;
    }
    R.hasOrientBtn = !!menuBox.querySelector('#orientButton');
    if (R.hasOrientBtn) {
        withMenu.viewerState.rotation = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
        withMenu.render('test');
        await frame();
        const before = rotOf(withMenu);
        menuBox.querySelector('#orientButton').click();
        // ...the button animates, so poll rather than sampling once. A big
        // structure skips the flight and lands immediately; a small one takes
        // about a second.
        for (let i = 0; i < 30 && rotOf(withMenu) === before; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        R.orientButtonMoved = rotOf(withMenu) !== before;
    }

    // FRAME-TO-FRAME ALIGNMENT, which viewer.py used to do with numpy before
    // the payload was built. addFrame does it now - the one funnel a static
    // payload, a streamed frame and an embed's own addFrame all arrive through.
    //
    // TO THE PREVIOUS FRAME, because that is what viewer.py did - each frame
    // aligned to the running result, which then became the reference.
    //
    // AND NOTHING HERE CAN PROVE THAT CHOICE, which is worth saying rather than
    // pretending otherwise. Kabsch is very nearly transitive: aligning to an
    // already-aligned neighbour composes to almost the same total rotation as
    // aligning to the original. Measured against numpy over a rigid trajectory,
    // a sheared one and a twisting one, chained and align-to-frame-zero differ
    // by at most 0.0006 A - far below anything a viewer shows.
    //
    // Two earlier versions of this comment claimed a test could tell them apart,
    // and a mutation pointing addFrame at frame zero walked through both. The
    // reference is a faithfulness-to-Python decision, not an observable one.
    // What IS checked below is that alignment happens at all, that the flag
    // turns it off, and that a drifting trajectory drifts monotonically.
    const spin = (t) => [[Math.cos(t), -Math.sin(t), 0],
                         [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
    const turn = (P, M) => P.map((p) => [
        p[0] * M[0][0] + p[1] * M[0][1] + p[2] * M[0][2],
        p[0] * M[1][0] + p[1] * M[1][1] + p[2] * M[1][2],
        p[0] * M[2][0] + p[1] * M[2][1] + p[2] * M[2][2]]);
    const helix = [];
    for (let i = 0; i < 30; i++) {
        helix.push([Math.cos(i * 0.6) * 5, Math.sin(i * 0.6) * 5, i * 1.5]);
    }
    const rmsd = (A, B) => Math.sqrt(A.reduce((s, p, i) => s
        + (p[0] - B[i][0]) ** 2 + (p[1] - B[i][1]) ** 2
        + (p[2] - B[i][2]) ** 2, 0) / A.length);

    const av = py2Dmol.show('align', PDB_TEXT);
    await frame();
    for (const [obj, wants] of [['on', true], ['off', false]]) {
        av.addObject(obj);
        for (let k = 0; k < 3; k++) {
            const f = {coords: turn(helix, spin(k * 0.7))};
            if (wants) f.align = true;
            av.addFrame(f, obj);
        }
    }
    const got = (obj) => av.objectsData[obj].frames.map((f) => f.coords);
    R.alignOn = [rmsd(got('on')[0], got('on')[1]),
                 rmsd(got('on')[0], got('on')[2])].map((x) => +x.toFixed(4));
    R.alignOff = +rmsd(got('off')[0], got('off')[1]).toFixed(3);

    // ...and the chained case, where the reference actually matters
    // SHEARED IN X, NOT Z. The turn below is about z, and a z-displacement is
    // invariant under it - so a z-bend leaves the optimal rotation unchanged and
    // the two references agree again. This one moves the xy pattern the fit is
    // computed from, which is what makes the reference matter.
    const bend = (P, k) => P.map((p, i) => [p[0] + i * 0.06 * k, p[1], p[2]]);
    av.addObject('chain');
    for (let k = 0; k < 4; k++) {
        av.addFrame({coords: turn(bend(helix, k), spin(k * 0.7)), align: true},
                    'chain');
    }
    const ch = got('chain');
    // A trajectory that deforms steadily should come out ordered: neighbours
    // closer than the ends. That catches alignment being skipped, applied to
    // the wrong array, or scrambling the order - not which reference it used.
    R.chainStep = +rmsd(ch[2], ch[3]).toFixed(3);
    R.chainEnds = +rmsd(ch[0], ch[3]).toFixed(3);

    // ...wireViewerUI IS here now, deliberately: controls:true mounts the
    // notebook's own panel and lets it do the wiring. What must hold is that
    // nothing appears unless it was asked for.
    R.hasPanelWirer = typeof window.wireViewerUI === 'function';
    R.hasPanelBuilder = !!(window.py2dmolPanel && window.py2dmolPanel.buildStylePanel);

    // ...and NEITHER PAINTER IS OPTIONAL HERE, so say which one drew. The
    // embed bundles carry cartoon/paintgl.js and no 2D painter: if the 2D one
    // is present the bundle is wrong, and if the GPU did not draw the cartoon
    // then something painted it that should not exist.
    // ...AND THE PUBLISHED PAGE ITSELF, driven the way a reader would drive it.
    // embed.html is the documentation, so every viewer on it must draw and
    // every button must do something. Four of them once did nothing at all -
    // three colour buttons that set a field behind a cache, and a whole
    // trajectory section showing "frame 1 of 1" because a multi-model file was
    // loaded one model deep.
    R.page = await drivePage();

    R.has2DPainter = typeof window.py2dmolCartoonPaint === 'function';
    R.gpuAvailable = !!(window.py2dmolCartoonGPU
        && window.py2dmolCartoonGPU.available
        && window.py2dmolCartoonGPU.available());
    R.useGPU = v.useGPU;
    R.gpuDrew = v.gpuDrewLastFrame === true;
  } catch (e) {
    R.threw = String((e && e.stack) || e).slice(0, 700);
  }
  finish();
})();
</script></body></html>"""


def cif_text():
    """A tiny mmCIF carrying the same trace, written here so the test does not
    depend on a .cif in the tree - they are all gitignored."""
    rows = []
    for i, line in enumerate(pdb_text().splitlines(), 1):
        if not line.startswith('ATOM'):
            continue
        x, y, z = line[30:38], line[38:46], line[46:54]
        res = line[17:20].strip()
        rows.append(f'ATOM {i} C CA . {res} A 1 {i} ? '
                    f'{x.strip()} {y.strip()} {z.strip()} 1.0 10.0 1 {i} A CA 1')
    head = ('data_TEST\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\n'
            '_atom_site.type_symbol\n_atom_site.label_atom_id\n'
            '_atom_site.label_alt_id\n_atom_site.label_comp_id\n'
            '_atom_site.label_asym_id\n_atom_site.label_entity_id\n'
            '_atom_site.label_seq_id\n_atom_site.pdbx_PDB_ins_code\n'
            '_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n'
            '_atom_site.occupancy\n_atom_site.B_iso_or_equiv\n'
            '_atom_site.pdbx_formal_charge\n_atom_site.auth_seq_id\n'
            '_atom_site.auth_asym_id\n_atom_site.auth_atom_id\n'
            '_atom_site.pdbx_PDB_model_num\n')
    return head + '\n'.join(rows) + '\n#\n'


def ligand_text():
    """The page's own trimmed trypsin, which is the fixture under test.

    Fetching 3PTB.cif instead would be 1,700 atoms on a page that already
    holds twenty viewers, and it would check a file nobody ships. The block
    inlined in embed.html is what the ligand examples are drawn from, so it is
    the one whose element symbols matter.
    """
    html = open(os.path.join(ROOT, "embed.html")).read()
    m = re.search(r'<script id="d-3ptb" type="text/plain">\n(.*?)\n</script>',
                  html, re.S)
    if not m:
        sys.exit('FAIL: embed.html has no d-3ptb block to test elements with')
    text = m.group(1)
    # ...AND ITS ELEMENT SYMBOLS ARE REAL ONES. Columns 77-78 of a PDB line
    # hold the element, and the first version of this block had the atom
    # serial there instead - every atom parsed as element "16", which is in no
    # colour table, so the ligand and the pocket side chains drew in one flat
    # colour and element colouring looked switched off while working perfectly
    # on nothing. Blank columns would have been FINE: the parser falls back to
    # the atom name. Garbage is what defeats it, which is why this checks the
    # symbols are symbols rather than merely present.
    seen = {ln[76:78].strip() for ln in text.split('\n')
            if ln.startswith(('ATOM', 'HETATM'))}
    junk = sorted(x for x in seen if x and not x.isalpha())
    if junk:
        sys.exit('FAIL: embed.html\'s trypsin block has ' + repr(junk)
                 + ' in the element columns (77-78), so its atoms parse as an'
                 ' element no colour table has')
    return text


def sample_code():
    """Every `v.<verb>(` and every `{key:` written in embed.html's <pre> blocks.

    THE PAGE'S PREMISE IS THAT THE CODE SHOWN IS THE CODE THAT RUNS - its own
    lede says "every button runs the code shown beside it" - and nothing
    checked the shown half. The buttons are driven below and the prose was not,
    so when the ligand section's demo was rewritten to use one selector and the
    <pre> beside it was not, the page went on displaying a call the running
    code had stopped making. A reader following it would have written a
    selector that no longer resolved.

    This cannot compare the sample to the demo line by line - they are prose and
    code. What it CAN do is refuse a sample that names something which does not
    exist: a verb the viewer does not have, or a selector key the grammar
    dropped. Both are what a rename leaves behind.
    """
    html = open(os.path.join(ROOT, "embed.html")).read()
    pres = re.findall(r"<pre>(.*?)</pre>", html, re.S)
    verbs, keys = set(), set()
    for block in pres:
        text = (block.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&amp;", "&"))
        # ...strip comments so prose inside them is not read as code
        text = re.sub(r"//[^\n]*", "", text)
        for m in re.finditer(r"\bv\.([a-zA-Z]+)\s*\(", text):
            verbs.add(m.group(1))
        for m in re.finditer(r"[{,]\s*([a-zA-Z_]+)\s*:", text):
            keys.add(m.group(1))
    return sorted(verbs), sorted(keys)


def documented():
    """What embed.html tells a reader it can do.

    THE PAGE IS THE DOCUMENTATION, so it is also the specification. Rather than
    keeping a list here that has to be remembered alongside it, this reads the
    calls out of the page: every `v.name(` it shows, every `py2Dmol.name(`, and
    every preset it offers. A promise added to the page is checked the moment it
    is added, and one that stops being true fails.
    """
    src = open(os.path.join(ROOT, 'embed.html')).read()
    viewer = sorted(set(re.findall(r'\bv\.(\w+)\(', src)))
    # ...MINUS THE PYTHON ONES. The page names py2Dmol.view(box=False) when
    # saying a flag means the same thing in the notebook, and that is not a
    # method of the JS object.
    PY_ONLY = {'view'}
    api = sorted(set(re.findall(r'\bpy2Dmol\.(\w+)\(', src)) - PY_ONLY)
    # ...named by EITHER spelling. The page uses setStyle('ribbon') now, because
    # the API takes one flat list; looking only for setPreset found none and the
    # check went quietly inert.
    presets = sorted({m for m in re.findall(r"set(?:Preset|Style)\('(\w+)'\)", src)
                      if m in ('richardson', 'ribbon', '3d')})
    if not viewer or not api or not presets:
        sys.exit('FAIL: embed.html no longer shows any calls, or names no'
                 ' presets - this test reads the page rather than keeping its'
                 ' own list, so it would pass forever')
    return viewer, api, presets


def shifted_text():
    """The same trace, moved well clear of the original.

    Two objects at the SAME coordinates draw the same picture, so overlaying
    them proves nothing - which is how the first version of this check passed
    while showObjects did nothing at all.
    """
    out = []
    for ln in pdb_text().splitlines():
        if not ln.startswith('ATOM'):
            continue
        out.append(ln[:30] + '%8.3f' % (float(ln[30:38]) + 25.0) + ln[38:])
    return '\n'.join(out) + '\nEND\n'


def many_text():
    """The same trace as three MODELs, so the play strip has something to play.

    Written here rather than taken from embed.html: the page's trajectory is
    1YNE at 14 KB, and this test only needs more than one frame.
    """
    one = [ln for ln in pdb_text().splitlines() if ln.startswith('ATOM')]
    out = []
    for m in range(1, 4):
        out.append('MODEL     %4d' % m)
        for i, ln in enumerate(one):
            # ...shifted, so the frames are not identical pictures
            x = float(ln[30:38]) + m * 0.7
            out.append(ln[:30] + '%8.3f' % x + ln[38:])
        out.append('ENDMDL')
    out.append('END')
    return '\n'.join(out)


def pdb_text():
    """The structure embed.html shows, read out of the page itself.

    NOT a copy. embed.html is the documentation for this API, so a test that
    carried its own structure could pass while the published page was broken.
    """
    src = open(os.path.join(ROOT, 'embed.html')).read()
    m = re.search(r'<script id="d-ubq"[^>]*>(.*?)</script>', src, re.S)
    if not m:
        sys.exit('FAIL: embed.html no longer carries its structure in #d-ubq -'
                 ' this test reads the page rather than keeping a copy')
    return m.group(1).strip()


def run():
    viewer_methods, api_methods, presets = documented()
    print(f'embed.html documents {len(viewer_methods)} viewer methods,'
          f' {len(api_methods)} on py2Dmol, {len(presets)} presets')
    sample_verbs, sample_keys = sample_code()
    print(f'embed.html samples call {len(sample_verbs)} viewer methods and use'
          f' {len(sample_keys)} object keys')
    page = (PAGE.replace('PDB_TEXT', json.dumps(pdb_text()))
                .replace('CIF_MANY', json.dumps(many_text()))
                .replace('SHIFTED_TEXT', json.dumps(shifted_text()))
                .replace('CIF_TEXT', json.dumps(cif_text()))
                .replace('DOC_VIEWER', json.dumps(viewer_methods))
                .replace('DOC_API', json.dumps(api_methods))
                .replace('DOC_PRESETS', json.dumps(presets))
                .replace('SAMPLE_VERBS', json.dumps(sample_verbs))
                .replace('SAMPLE_KEYS', json.dumps(sample_keys))
                .replace('LIG_TEXT', json.dumps(ligand_text())))
    open(PROBE, 'w').write(page)

    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            box.append(json.loads(self.rfile.read(n)))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.request_queue_size = 128
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    p = subprocess.Popen(
        [CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-embed",
         "--no-first-run", "--window-size=900,900",
         f"http://127.0.0.1:{PORT}/_embed_probe.html"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end:
        time.sleep(0.5)
    p.kill()
    httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-embed", ignore_errors=True)
    if not box:
        sys.exit('FAIL: the page never posted a result')
    return box[0]


R = run()
os.path.exists(PROBE) and os.remove(PROBE)
bad = []
PAGE = R.get('page') or {}
stray = PAGE.get('strayMargins') or []
if stray:
    bad.append('the page\'s own CSS reached into the viewer chrome: '
               + ', '.join(stray[:4]) + ' - every selector in the shell is'
               ' scoped so it cannot take the host page\'s controls, and it has'
               ' to reset what it does not set for the same reason')
gaps = PAGE.get('rowGaps') or []
uneven = [g for g in gaps if g[0] != g[1]]
if uneven:
    bad.append(f'{len(uneven)} of {len(gaps)} viewers space their buttons and'
               f' their rows differently, e.g. {uneven[0]} - the sheet gives'
               ' both the same number, so anything else came from outside')
if not gaps:
    bad.append('no button rows measured - this check has stopped finding the'
               f' chrome and would pass forever (cols={PAGE.get("colCount")},'
               f' rows={PAGE.get("btnRowCount")})')

cue = PAGE.get('cue')
if cue is None:
    bad.append('the Style and Capture buttons were not found in the shell, so'
               ' the open cue is unmeasured')
elif cue.get('expanded') != 'true':
    bad.append('opening the Save panel set no aria-expanded on its button')
elif cue.get('open') == cue.get('closed'):
    bad.append(f"Capture looks the same open as closed ({cue.get('open')}) -"
               " the shell's open cue named #styleToggle, so only one of the"
               ' two panel buttons ever lit')
elif cue.get('reclosed') != cue.get('closed'):
    bad.append(f"Capture stayed lit after its panel closed:"
               f" {cue.get('reclosed')} against {cue.get('closed')}")
elif cue.get('styleOpen') != cue.get('open'):
    bad.append(f"Style open is {cue.get('styleOpen')} and Capture open is"
               f" {cue.get('open')} - one state, one skin")

if R.get('threw'):
    bad.append('the embed threw: ' + R['threw'])
for e in R.get('errors', []):
    bad.append('uncaught: ' + e)
if not R.get('hasApi'):
    bad.append('window.py2Dmol.show is not defined - the bundle has no entry point')

# INK, WITH A FLOOR THAT MEANS SOMETHING. A blank 320x320 canvas is 0; a
# ubiquitin trace covers thousands of pixels. Anything in between is a viewer
# that started and drew almost nothing, which is the failure a `> 0` would pass.
for key, what in (('tubeInk', 'tube'), ('cartoonInk', 'cartoon'),
                  ('cifInk', 'mmCIF')):
    n = R.get(key, 0)
    print(f'  {what:>8}: {n} pixels')
    if n < 2000:
        bad.append(f'{what} drew {n} pixels - a ubiquitin trace covers thousands')

for n in R.get('sampleBadVerbs', []):
    bad.append(f'embed.html shows v.{n}() in a code sample, and the viewer has'
               ' no such method - the page teaches a call that does not exist')
for k in R.get('sampleBadKeys', []):
    bad.append(f'embed.html shows a selector key {k!r} in a code sample, and'
               ' the grammar does not have it - a rename left it behind in the'
               ' prose')
for n in R.get('missingOnViewer', []):
    bad.append(f'embed.html documents v.{n}(), and the renderer has no such method')
for n in R.get('missingOnApi', []):
    bad.append(f'embed.html documents py2Dmol.{n}(), which does not exist')
for style, n in sorted(R.get('styleResults', {}).items()):
    print(f'  {style:>10}: {n} pixels')
    if n < 2000:
        bad.append(f'setStyle({style!r}) drew {n} pixels')
for preset, n in sorted(R.get('presetResults', {}).items()):
    print(f'  {preset:>10}: {n} pixels')
    if n < 2000:
        bad.append(f'setPreset({preset!r}) is documented on embed.html and drew {n} pixels')
    if not R.get('presetTook', {}).get(preset):
        bad.append(f'setPreset({preset!r}) is documented on embed.html but the'
                   ' renderer did not end up on it - the name is not one it knows')
if not R.get('rotationChanged'):
    bad.append('a drag changed no pixels - the gestures are not wired,'
               ' or they live in the panel the embed does not load')
if R.get('twoCanvases') != 2 or not R.get('separate'):
    bad.append(f"two embeds share a canvas ({R.get('twoCanvases')} canvases,"
               f" separate={R.get('separate')}) - #canvas is being found globally")
page = R.get('page') or {}
for e in page.get('errors', []):
    bad.append('embed.html raised: ' + e)
print(f"  page ready after {page.get('waited')} ms")
if not page.get('viewers'):
    bad.append('no .canvas-box viewers found on embed.html - either the page'
               ' changed shape, or it never finished loading (it was given'
               f" {page.get('waited')} ms)")
for vid, ink in sorted(page.get('viewers', {}).items()):
    print(f'  page #{vid}: {ink} pixels')
    if not ink or ink < 2000:
        bad.append(f'embed.html #{vid} drew {ink} pixels - a published example'
                   ' that does not draw')
# EVERY SECTION'S EXAMPLE RAN, AND PRINTED ITSELF.
#
# A section is one complete program now, not a row of buttons swapping one call
# each. That removes the whole class of drift the button rows needed checking
# for - the shown code IS the run code, there is no second copy - and leaves
# two things worth asserting: the box filled, and what it ran did not throw.
for box, info in sorted(page.get('boxes', {}).items()):
    n = len(info.get('code') or '')
    print(f'  page {box}: {n} chars of code'
          + (' THREW' if info.get('threw') else ''))
    if not info.get('code'):
        bad.append(f'embed.html {box} printed no code - the example and its'
                   ' display have come apart')
    if info.get('threw'):
        bad.append(f'embed.html {box} threw when it ran: '
                   + (info.get('code') or '')[-200:])
    if info.get('spill') is not None and info['spill'] > 0:
        bad.append(f"embed.html {box}: the viewer above it runs"
                   f" {info['spill']}px into the code beneath - a viewer with a"
                   ' panel or a player is taller than its canvas, so its'
                   ' container must not have a fixed height')
if len(page.get('boxes', {})) < 12:
    bad.append(f"only {len(page.get('boxes', {}))} examples printed code -"
               ' the page has stopped running its own sections')

# ...and the trajectory really is a trajectory. "frame 1 of 1" is what a
# multi-model file looks like when only its first model was read.
label = page.get('label') or ''
if not re.search(r'/\s*([2-9]|\d\d)', label):
    bad.append(f'embed.html frame label reads {label!r} - the multi-model'
               ' example is loading a single frame again')

bare, menu = R.get('chromeBare', {}), R.get('chromeMenu', {})
print(f"  chrome: bare {bare.get('selects')} rows {bare.get('rows')};"
      f" controls {menu.get('selects')} rows {menu.get('rows')}")
if bare.get('selects'):
    bad.append(f"a plain embed grew {bare['selects']} dropdowns - controls"
               ' defaults to off')
if [r for r in bare.get('rows', []) if r != 'none']:
    bad.append(f"a plain single-frame embed shows a visible row {bare['rows']}"
               ' - the play strip must stay hidden with nothing to play')
if not R.get('hasSave'):
    bad.append("controls:true has no Save button - viewer.html puts one beside"
               ' Style, and this is meant to be that panel')
if not R.get('hasStyleBtn'):
    bad.append('controls:true has no Style button')
# ...PNG always; SVG only where a 2D painter can produce a vector. This bundle
# is the WebGL2 one, so the menu must not offer a format it cannot write.
fmts = R.get('saveFormats') or []
if 'png' not in fmts:
    bad.append(f'the Save panel offers {fmts}, with no PNG')
# ...and SVG IS offered here, correctly: this viewer is in tube, which
# _drawFrame draws in core/mol.js without any cartoon painter at all. The format
# is hidden for the CARTOON in a GPU-only build, which is the case that needs a
# painter it does not have.
if 'svg' not in fmts:
    bad.append(f'the Save panel offers {fmts} for a TUBE - vector export needs'
               ' no cartoon painter, so it should be there')
if not R.get('svgHiddenForCartoon'):
    bad.append('SVG is still offered for a cartoon in the WebGL build, which'
               ' cannot produce it')
# ...the panel's dropdowns, in the order parts/panel.js lists them: style,
# colour, and how a selection is marked. The third arrived with the shared
# panel and so arrived HERE, in the embed, without the embed being touched -
# which is the point of the shared panel and the reason this reads the whole
# list rather than the first two.
if menu.get('selects') != ['tube', 'auto', 'highlight']:
    bad.append(f"controls:true gave {menu.get('selects')}, expected the style,"
               ' colour and selection-mark dropdowns reading tube, auto, highlight')
after = R.get('chromeAfterCode', {})
if (after.get('selects') or [None])[0] != 'ribbon':
    bad.append(f"after setStyle('ribbon') the dropdown reads"
               f" {(after.get('selects') or [None])[0]!r} - it must follow a"
               ' change made from code, and an empty value means the internal'
               ' style name was written into a list of flat names')
play = R.get('chromePlay', {})
print(f"  chrome: {R.get('chromePlayFrames')} frames -> rows"
      f" {play.get('rows')}, play button shown {play.get('btnShown')}")
if not play.get('btnShown'):
    bad.append('a multi-frame embed does not show its play button')
if not R.get('chromeFrameMoved'):
    bad.append('setFrame(1) on the play strip changed no pixels - the strip is'
               ' not wired to the frames')
if not R.get('chromePlaying'):
    bad.append('togglePlay did not start playback')
if not R.get('chromeStopped'):
    bad.append('togglePlay did not stop playback again')

walk = R.get('walk', [])
if len(walk) < 7:
    bad.append(f'the style walk ran {len(walk)} steps - it stopped early')
seen = {}
for step in walk:
    print(f"  walk setStyle({step['set']:<11}) -> {step['style']}/{step['preset']}"
          f"  {step['ink']} px")
    if step['ink'] < 2000:
        bad.append(f"setStyle({step['set']!r}) drew {step['ink']} pixels")
    want_style = 'tube' if step['set'] == 'tube' else 'cartoon'
    if step['style'] != want_style:
        bad.append(f"setStyle({step['set']!r}) left style {step['style']!r}")
    seen.setdefault(step['set'], []).append(step)
# ...the same name must give the same picture wherever it is reached from, and
# tube must not be one of the cartoons
for name, steps in sorted(seen.items()):
    shots = {st['shot'] for st in steps}
    if len(shots) > 1:
        bad.append(f'setStyle({name!r}) drew {len(shots)} different pictures'
                   f' across {len(steps)} visits - what it draws depends on'
                   ' where it was reached from')
tube_shot = seen['tube'][0]['shot'] if 'tube' in seen else None
for name in ('ribbon', 'richardson'):
    if name in seen and seen[name][0]['shot'] == tube_shot:
        bad.append(f'setStyle({name!r}) drew the tube picture - the state says'
                   ' cartoon and the canvas was never repainted')
if 'ribbon' in seen and 'richardson' in seen \
        and seen['ribbon'][0]['shot'] == seen['richardson'][0]['shot']:
    bad.append('ribbon and richardson draw the identical picture - a preset'
               ' switch is not reaching the canvas')
# ...and 'cartoon' means THE CARTOON PATH, keeping whichever preset is live.
# It is not a fifth look: from tube it lands on the remembered preset, which
# is richardson on a viewer that has never been anywhere else.
cart = seen.get('cartoon', [None])[0]
if cart and cart['preset'] != '3d':
    bad.append(f"setStyle('cartoon') after 3d moved the preset to"
               f" {cart['preset']!r} - it should keep the live one")

paths = R.get('presetPaths', {})
if len(paths) < 4:
    bad.append(f'only {len(paths)} preset paths were probed - the loop stopped'
               ' running and this check would pass on anything')
for label, both in sorted(paths.items()):
    built, switched = both['built'], both['switched']
    differs = [k for k in switched if built.get(k) != switched.get(k)]
    print(f"  preset {label:<11} built vs setPreset({both['name']}):"
          f" {'identical' if not differs else 'DIFFER on ' + ', '.join(differs)}")
    for k in differs:
        bad.append(f"built with preset {label!r}: {k}={built.get(k)!r}, but"
                   f" setPreset({both['name']!r}) makes it {switched.get(k)!r}"
                   ' - the two ways into a preset do not agree')
    if built.get('preset') != both['name']:
        bad.append(f"built with preset {label!r} reports stylePreset"
                   f" {built.get('preset')!r}, expected {both['name']!r}")
    want_rich = both['name'] == 'richardson'
    if built.get('rich') is not want_rich:
        bad.append(f"built with preset {label!r} has cartoonRichardson"
                   f" {built.get('rich')!r}, expected {want_rich}")

if R.get('has2DPainter'):
    bad.append('cartoon/paint2d.js is in the embed bundle - it is meant to be'
        ' GPU-only, and shipping both painters means neither is the one path')
if not R.get('gpuAvailable'):
    bad.append('window.py2dmolCartoonGPU.available() is false - this bundle has no'
        ' painter it can use, so it draws nothing')
if R.get('useGPU') is not True:
    bad.append(f"renderer.useGPU is {R.get('useGPU')!r} - py2Dmol.show must ask for the"
        ' GPU, because it is the only painter in the bundle')
if not R.get('colourRange'):
    bad.append('setColor with a {range} changed no pixels')
if not R.get('colourChain'):
    bad.append('setColor with a {chain} changed no pixels')
if not R.get('colourSpec'):
    bad.append('a range then a chain did not MERGE into one advanced spec -'
               ' the second write replaced the first')
if not R.get('contactsDrawn'):
    bad.append('setContacts drew nothing')
if not R.get('contactsCleared'):
    bad.append('setContacts([]) did not take the lines away again')
if R.get('twoObjects') != ['A', 'B']:
    bad.append(f"showObjects(['A','B']) draws {R.get('twoObjects')}")
if not R.get('twoDrawn'):
    bad.append('a second structure in the same viewer changed no pixels')

if R.get('reloadNames') != ['structure']:
    bad.append(f"v.load(text) with no name left {R.get('reloadNames')} - it is"
               " reaching addObject(undefined) and addFrame is inventing '0'")
if R.get('reloadFrames') != 1:
    bad.append(f"v.load() under a name in use gave {R.get('reloadFrames')}"
               ' frames - it APPENDED a different structure to the object'
               ' instead of replacing it')
if R.get('bg3dShow') != '#000000':
    bad.append(f"show({{style: '3d'}}) came up on {R.get('bg3dShow')} - 3d is"
               ' solid geometry and is drawn to be seen on black')
if R.get('bg3dOverride') != '#ffffff':
    bad.append(f"bg: 'white' with style 3d gave {R.get('bg3dOverride')} - an"
               ' explicit background must beat the look default')
if R.get('bgAfterTube') != '#ffffff':
    bad.append(f'leaving 3d for tube left the page {R.get("bgAfterTube")}')
if R.get('bg3dAgain') != '#000000':
    bad.append(f'3d a SECOND time came up on {R.get("bg3dAgain")} - the recall'
               ' short-circuit in setStyle returns without restoring the look'
               " background, so black is a first-visit-only effect")
if R.get('panelSpillDown') is None or R.get('panelSpillDown') > 1:
    bad.append(f"the open Style panel hangs {R.get('panelSpillDown')}px below a"
               ' fixed-height container - an embed must stay inside the box the'
               ' host page gave it')
if R.get('panelSpillRight') is None or R.get('panelSpillRight') > 1:
    bad.append(f"the panel runs {R.get('panelSpillRight')}px past the right"
               ' edge of its container')
if R.get('narrowSpillRight') is None or R.get('narrowSpillRight') > 1:
    bad.append(f"in a container too narrow for canvas-plus-panel the panel"
               f" sticks {R.get('narrowSpillRight')}px out of the side instead"
               ' of wrapping under the canvas')
if not R.get('narrowWrapped'):
    bad.append('the narrow container did not wrap the panel under the canvas')
if not R.get('panelScrolls'):
    bad.append('the panel was clamped to the container without becoming'
               ' scrollable, so the controls below the fold cannot be reached')
if R.get('visKept') != R.get('visAsked'):
    bad.append(f"setVisibility({{positions: {R.get('visAsked')} of"
               f" {R.get('visTotal')}}}) left {R.get('visKept')} visible - the"
               ' patch names what STAYS, and embed.html documents that')
if R.get('visEmptyDefault') != R.get('visTotal'):
    bad.append(f"an empty positions set under the default mode left"
               f" {R.get('visEmptyDefault')} of {R.get('visTotal')} visible -"
               ' it is read as "not set" and normalised to everything, which is'
               ' the trap embed.html names')
if R.get('visEmptyExplicit') != 0:
    bad.append(f"an empty positions set with visibilityMode:'explicit' left"
               f" {R.get('visEmptyExplicit')} visible - that is hideAll's own"
               ' spelling and must draw nothing')
if R.get('visReset') != R.get('visTotal'):
    bad.append(f"resetVisibility left {R.get('visReset')} of"
               f" {R.get('visTotal')} visible")
sp = R.get('selSpellings') or {}
if not sp.get('agree') or not sp.get('string'):
    bad.append(f"'A', {{chain:'A'}} and {{chains:['A']}} do not resolve to the"
               f' same residues: {sp}')
if not (R.get('selArray') == R.get('selRange') == R.get('selSet')):
    bad.append('an array, a Set and a {range} naming the same three positions'
               f" gave {R.get('selArray')}, {R.get('selSet')} and"
               f" {R.get('selRange')}")
if R.get('selResidues') == R.get('selPositions'):
    bad.append('{residues: [1,2,3]} and {positions: [1,2,3]} resolved to the'
               ' same set - residue numbers are what the file says and'
               ' positions count from zero, and 1UBQ starts at residue 1')
if R.get('selAnd') != 2 or R.get('selAndMiss') != 0:
    bad.append(f"selector keys are not ANDing: chain+residues gave"
               f" {R.get('selAnd')} (expected 2) and a missing chain gave"
               f" {R.get('selAndMiss')} (expected 0)")
if R.get('invCleanHide') != R.get('invCleanAbs'):
    bad.append('from a clean viewer, hide(x) and reset-then-hide(x) must agree'
               f" - got {R.get('invCleanHide')} and {R.get('invCleanAbs')}")
if R.get('invDirtyHide') == R.get('invDirtyAbs'):
    bad.append('hide(x) and reset-then-hide(x) came out the same from a viewer'
               ' that already had something hidden - they must NOT. hide is'
               ' RELATIVE to what is showing, which is the one thing an'
               ' absolute spelling cannot express; if these agree, hide is not'
               ' relative to anything and does not need to exist')
if R.get('invDirtyHide') != 60 or R.get('invDirtyAbs') != 66:
    bad.append(f"hide-then-hide left {R.get('invDirtyHide')} (expected 60) and"
               f" reset-then-hide left {R.get('invDirtyAbs')} (expected 66,"
               ' the six put back)')
if R.get('drawOnly') != 10:
    bad.append(f"reset + hide({{not: x}}) drew {R.get('drawOnly')} of the ten"
               ' asked for - that composition is how an embed says "only"')
if R.get('notComposes') != R.get('selSpellings', {}).get('string', 0) - 3:
    bad.append(f"{{chain:'A', not:{{residues:[1,2,3]}}}} gave"
               f" {R.get('notComposes')} - not must NARROW what the other keys"
               ' matched, not replace it')
if R.get('notWhole') != R.get('selTotal', 0) - 10:
    bad.append(f"{{not: {{range:[0,10]}}}} gave {R.get('notWhole')} of"
               f" {R.get('selTotal')}, expected all but ten")
if not R.get('typoThrew'):
    bad.append('a misspelled selector key did not throw - it narrows nothing,'
               ' so it silently means "everything"')
tot = R.get('selTotal')
if R.get('visAfterHide') != (tot - 10 if tot else None):
    bad.append(f"hide({{range:[0,10]}}) left {R.get('visAfterHide')} of {tot}"
               ' visible - hide must remove exactly what it names')
if R.get('visAfterShow') != tot:
    bad.append(f"show() put back {R.get('visAfterShow')} of {tot}")
if R.get('visAfterShowOnly') != 10:
    bad.append('reset + hide({not: {range:[0,10]}}) drew'
               f" {R.get('visAfterShowOnly')}, expected 10")
if R.get('visAfterReset') != tot:
    bad.append(f"resetVisibility left {R.get('visAfterReset')} of {tot}")
if not R.get('colourByChainString'):
    bad.append("setColor('red', 'A') changed no pixels - the bare-string"
               ' shorthand is not reaching the chain path')
if not R.get('orientSelectorWins'):
    bad.append('v.orient(selector) gave a different view with and without a'
               ' standing selection - the selector must decide what is framed,'
               ' not whatever happened to be selected')
if not R.get('orientDiffersFromSelection'):
    bad.append('orienting on a selector and orienting on the standing'
               ' selection gave the SAME view, so this check cannot tell them'
               ' apart and proves nothing')
if len(R.get('unifyAccepted') or []) != 5:
    bad.append(f"only {R.get('unifyAccepted')} of the five verbs exist")
if not R.get('clipSetSlab'):
    bad.append('clip(selector) set no slab at all')
if R.get('unifyDistinct') != R.get('unifySteps'):
    bad.append(f"one selector through {R.get('unifySteps')} verbs reached only"
               f" {R.get('unifyDistinct')} distinct pictures - every verb must"
               ' accept the same selector AND act on it. Identical steps:'
               f" {R.get('unifyDupes')}")
if not R.get('sidechainThrew'):
    bad.append('showSidechains on a C-alpha trace did not say there are no'
               ' side-chain atoms - it must refuse loudly, not quietly draw'
               ' nothing')
if not R.get('bareManyStrip'):
    bad.append(f"a plain embed of a {R.get('bareManyFrames')}-frame file has no"
               ' frame strip - play is meant to follow the file rather than'
               ' being asked for')
if R.get('bareOneStrip'):
    bad.append('a single-structure embed grew a frame strip - it should stay'
               ' the bare canvas it was')
if not R.get('bareOneRefused'):
    bad.append('play: false did not refuse the strip on a multi-frame file')
if R.get('selFirst') != 10 or R.get('selAdded') != 15:
    bad.append(f"select is not additive: {R.get('selFirst')} then"
               f" {R.get('selAdded')}, expected 10 then 15 - it must add to the"
               ' selection the way show adds to what is visible')
if R.get('selRemoved') != 12:
    bad.append(f"unselect(3 of them) left {R.get('selRemoved')}, expected 12")
if R.get('selCleared') != 0:
    bad.append('unselect() with no argument did not clear')
if R.get('selAll') != R.get('selTotal'):
    bad.append(f"select() with no argument took {R.get('selAll')} of"
               f" {R.get('selTotal')} - a selector with no keys is everything")
if not R.get('hasFetch'):
    bad.append('py2Dmol.fetch is missing, and embed.html documents it')
if not R.get('fetchRejects'):
    bad.append('py2Dmol.fetch("") resolved instead of rejecting')
if not R.get('buPlain') or R.get('buAsm', 0) <= R.get('buPlain', 0):
    bad.append(f"a plain show() of a porin gave {R.get('buAsm')} positions and"
               f" biounit:false gave {R.get('buPlain')} - the assembly is meant"
               ' to be built by default')
if R.get('buNone') != R.get('buNonePlain'):
    bad.append(f"the default changed a file with no assembly records"
               f" ({R.get('buNonePlain')} -> {R.get('buNone')}) - it must cost"
               ' nothing when there is nothing to build')
if not R.get('elemOwners'):
    bad.append('no element owners on a structure with a ligand')
if not R.get('elemHidden'):
    bad.append('hideElements changed no pixels - element colours are on by'
               ' default, so turning them off must be visible')
if not R.get('elemRestored'):
    bad.append('showElements did not put the element colours back')
orth = R.get('ortho') or []
print("  ortho: " + ", ".join(
    f"asked {o['asked']} -> {o['got']} (focal {o['focal']})" for o in orth))
if len(orth) != 3:
    bad.append('the ortho check did not run')
else:
    for o in orth:
        if o['got'] != o['asked']:
            bad.append(f"rendering.ortho {o['asked']} reached viewerState as"
                       f" {o['got']} - an embed has no ortho slider, and the"
                       ' four places that seed the field read only the slider')
    persp = [o for o in orth if o['asked'] < 1]
    if any(o['focal'] <= 0 or o['focal'] == 200.0 for o in persp):
        bad.append(f"perspective was asked for and the focal length is still"
                   f" the 200 default: {[o['focal'] for o in persp]}. Nothing"
                   ' recalibrates it without a slider, so the camera stands at'
                   ' a distance with no relation to the structure')
if R.get('orthoDistinct') != 3:
    bad.append(f"three ortho settings drew {R.get('orthoDistinct')} distinct"
               ' pictures - the value is being stored and not projected with')

print(f"  replaceFrame: {R.get('rfBefore')} frames ->"
      f" {R.get('rfAfter')} after a replace, {R.get('rfStable')} after three")
if R.get('rfBefore') != 2:
    bad.append(f"the fixture has {R.get('rfBefore')} frames, not the two this"
               ' needs to tell a replace from an append')
if R.get('rfAfter') != R.get('rfBefore') or R.get('rfStable') != R.get('rfBefore'):
    bad.append(f"replaceFrame changed the frame count ({R.get('rfBefore')} ->"
               f" {R.get('rfAfter')} -> {R.get('rfStable')}) - appending is what"
               ' it exists not to do')
if not (R.get('rfSwapped') or 0) > 20:
    bad.append(f'replaceFrame kept the count and moved nothing'
               f" (x shifted by {R.get('rfSwapped')}) - a call that quietly did"
               ' nothing would pass every count check above')
if not R.get('rfNeighbourIntact'):
    bad.append('replaceFrame disturbed the frame before it')
if not R.get('rfRefusesUnknown'):
    bad.append('replaceFrame accepted an object that does not exist instead of'
               ' saying so')
print(f"  superpose: {R.get('spApart', 0):.2f} A apart ->"
      f" {R.get('spWhole', -1):.1e} whole, {R.get('spSubset', -1):.1e} from a subset")
if not (R.get('spApart') or 0) > 1:
    bad.append('the superpose fixture is not actually displaced, so a fit that'
               ' did nothing would score as a perfect one')
for key, what in (('spWhole', 'every point'), ('spSubset', 'a six-point subset')):
    if R.get(key) is None or R[key] > 1e-6:
        bad.append(f'superpose fitting on {what} left an RMSD of {R.get(key)}')
if not R.get('spExtraMoved'):
    bad.append('an atom outside the fitted subset did not travel with the body'
               ' - fitting on a subset and applying to everything is the whole'
               ' reason this takes from/to at all')
if not R.get('spMobileUntouched'):
    bad.append('superpose edited the coordinates it was given rather than'
               ' returning new ones')
for name, threw in (R.get('spRefuses') or {}).items():
    if not threw:
        bad.append(f'superpose accepted a bad call ({name}) instead of'
                   ' refusing it - a fit on nonsense returns NaN for every'
                   ' atom, and a NaN structure draws as nothing at all')
if not R.get('scColourInk'):
    bad.append('the side-chain colour viewer drew nothing at all, so the three'
               ' comparisons below are between two blank canvases')
if not R.get('scColourInertWithNoSidechains'):
    bad.append('setSidechainColor changed pixels while no side chain was'
               ' drawn - it is meant to reach the side-chain atoms and nothing'
               ' else, so with none on screen it has nothing to colour')
if not R.get('scColourSidechainsDrawn'):
    bad.append('no side chains appeared, so the colour comparison below has'
               ' nothing to be a colour of')
if not R.get('scColourDrew'):
    bad.append("setSidechainColor('hydrophobicity') and setSidechainColor(null)"
               ' drew the same side chains - either the colour never reaches a'
               ' pixel, or unset does not mean follow the residue. Both are'
               ' invisible to every arithmetic check of the map')
if not R.get('scColourRepeatable'):
    bad.append('setting the same side-chain colour twice gave two different'
               ' pictures')
if sorted(R.get('elemSymbols') or []) == []:
    bad.append("embed.html's inlined structure has no element symbols in"
               ' columns 77-78, so its ligand and side chains draw in one flat'
               ' colour and element colouring looks switched off')
if not R.get('selectionOn'):
    bad.append('clicking the canvas does not select in an embed -'
               ' selectionEnabled is still at the renderer default')
if not R.get('selectionOff'):
    bad.append('{select: false} did not turn click-selection off')
if not R.get('clickPainted'):
    bad.append('a click selected a residue and the canvas did not change -'
               ' the halo waits for the next rotate or zoom, because'
               ' setResidueSelection only dispatches an event and an embed has'
               ' nobody listening')
if not R.get('clearedOnBackground'):
    bad.append('a click on the background did not clear the selection')
if not R.get('clearPainted'):
    bad.append('clearing the selection left the halo on the canvas')
if R.get('clickPicked') != 1:
    bad.append(f"a click on the structure picked {R.get('clickPicked')}"
               ' residues, expected 1')
if not R.get('showOriented'):
    bad.append('py2Dmol.show left the camera at the identity - an embed is not'
               ' orienting on load, so a structure comes up in whatever frame'
               ' its file was deposited in')
if not R.get('showOrientedBest'):
    bad.append('show() turned the camera somewhere that is not the best view')
if not R.get('orientOff'):
    bad.append('{orient: false} still oriented on load')
if not R.get('orientMoved'):
    bad.append('v.orient() left the rotation matrix where it was')
if not R.get('orientDrew'):
    bad.append('v.orient() turned the camera and changed no pixels')
if not R.get('orientRepeatable'):
    bad.append('two orients from two different starts landed on two different'
               ' views - the search is not converging on a best view')
if not R.get('hasOrientBtn'):
    bad.append('controls:true has no Orient button')
elif not R.get('orientButtonMoved'):
    bad.append('the Orient button is in the shell and wired to nothing -'
               ' wireViewerUI does not know about it, embed.js must')

on, off = R.get('alignOn') or [], R.get('alignOff')
print(f'  align: on {on} A apart, off {off} A apart')
if not on or max(on) > 1e-3:
    bad.append(f'align:true left the frames {on} A apart - addFrame is not'
               ' superposing them, which viewer.py used to do in numpy')
if not off or off < 1:
    bad.append(f'align:false still superposed the frames ({off} A apart) -'
               ' the flag is being ignored in the other direction')
step, ends = R.get('chainStep'), R.get('chainEnds')
print(f'  align: chained, neighbours {step} A, ends {ends} A')
if step is None or ends is None:
    bad.append('the chained trajectory did not run')
elif not (step < ends):
    bad.append(f'consecutive frames are {step} A apart and the ends {ends} A -'
               ' a steadily deforming trajectory should come out ordered, so'
               ' the frames are not being superposed in sequence')

if not R.get('hasPanelWirer') or not R.get('hasPanelBuilder'):
    bad.append('the embed bundle has no wireViewerUI/panel builder, so'
               ' controls:true cannot mount the real panel')

for b in bad:
    print('FAIL: ' + b)
print('ok' if not bad else f'{len(bad)} problems')
sys.exit(1 if bad else 0)
