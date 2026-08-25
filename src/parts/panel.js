// ============================================================================
// src/parts/panel.js
// --------------------------------
// AI Context: THE STYLE PANEL, ONCE (buildStylePanel)
// - The rows, the ids, the ranges and the tooltips - as data, built into DOM at
//   runtime. Both pages get the same panel from here; only the CSS differs.
// ============================================================================
(function () {
'use strict';

// ONE PANEL, TWO SKINS. This markup used to be written out twice - in
// index.html and in py2Dmol/resources/viewer.html - under a comment reading
// "MIRRORS index.html's #stylePanel row for row ... Edit BOTH files when a
// control changes."
//
// It had already failed, in both directions: viewer.html carried a Bases
// toggle index.html did not have, and index.html a Detect-cyclic toggle
// viewer.html did not. Nobody could see it, because seeing it meant diffing
// two hundred lines of nested <div> across two files.
//
// So the rows are DATA now, and each page builds them. The union of the two is
// what both get, which is how the notebook gained Detect-cyclic and the web app
// gained Bases. The class names are unchanged - `toggle-item`, `half`,
// `btn-toggle` - because the skin is still each page's own stylesheet, and that
// was always the real contract: same DOM, different CSS.

// Kinds: 'select' (a dropdown), 'range' (a slider), 'toggle' (a checkbox that
// looks like a button), 'slot' (an empty div a subsystem fills in).
//
// `half` wraps the item in a half-cell, which index.html pairs two-across and
// viewer.html stacks. `style` sets data-style, so syncStylePanel shows the row
// only for that draw path; `needsSs` sets data-needs-ss.
const STYLE_PANEL_ROWS = [
    [{ kind: 'select', id: 'styleSelect', label: 'Style', half: true,
       title: 'Tube is the backbone trace; the other three are cartoons.'
            + ' The sliders stay live under any of them.',
       options: [['tube', 'Tube'], ['richardson', 'Richardson'],
                 ['ribbon', 'Ribbon'], ['3d', '3D']] }],


    [{ kind: 'range', id: 'lineWidthSlider', label: 'Width', half: true,
       min: 2.0, max: 4.7, value: 3.0, step: 0.1 },
     { kind: 'range', id: 'outlineWidthSlider', label: 'Outline', half: true,
       min: 0, max: 3, value: 3.0, step: 0.1,
       title: 'Outline thickness. 0 turns the outline off.' }],

    [{ kind: 'range', id: 'thicknessSlider', label: 'Thick', half: true,
       style: 'cartoon', min: 0, max: 1.5, value: 0, step: 0.05,
       title: 'Cartoon slab thickness (0 = flat)' },
     { kind: 'range', id: 'sheetFlatSlider', label: 'Flat', half: true,
       style: 'cartoon', min: 0, max: 1, value: 0, step: 0.05,
       title: 'Flatten beta strands (0 = natural pleat, 1 = flat)' }],

    [{ kind: 'range', id: 'highlightSlider', label: 'Hilite', half: true,
       style: 'cartoon', min: 0, max: 3, value: 1.8, step: 0.05,
       title: 'Brightness lift on faces pointing at the light'
            + ' (0 = base colour is the ceiling)' },
     { kind: 'range', id: 'shadeSlider', label: 'Shade', half: true,
       style: 'cartoon', min: 0, max: 1, value: 1, step: 0.05,
       title: 'Directional shading: 0 = flat colour, 1 = full light,'
            + ' highlight and inner shadow' }],

    [{ kind: 'range', id: 'pencilSlider', label: 'Pencil', half: true,
       style: 'cartoon', min: 0, max: 1, value: 0, step: 0.05,
       title: 'Coloured-pencil paper grain (0 = clean)' },
     { kind: 'range', id: 'shadowSlider', label: 'Shadow', half: true,
       style: 'tube', min: 0, max: 1, value: 0.5, step: 0.01,
       title: 'Shadow strength. 0 turns shadow off. Cartoon reads on/off only.' },
     { kind: 'range', id: 'outlineTintSlider', label: 'Ink', half: true,
       style: 'cartoon', min: 0, max: 1, value: 0, step: 0.05,
       title: 'Outline colour: 0 = black, 1 = tint of the element colour'
            + ' (as in ribbon mode)' },
     // ...Detail and Ortho close this same flow rather than opening a new row,
     // which is what puts Shadow beside Ortho in tube: the three cartoon-only
     // cells collapse and the two survivors pack onto one line. In two rows
     // tube showed each of them alone.
     { kind: 'range', id: 'detailSlider', label: 'Detail', half: true,
       style: 'cartoon', min: 2, max: 8, value: 4, step: 1,
       title: 'Subdivisions per residue, 2-8 (low = faceted and faster)' },
     { kind: 'range', id: 'orthoSlider', label: 'Ortho', half: true,
       min: 0, max: 1, value: 0.5, step: 0.01 }],

    // ORDERED BY HOW OFTEN A MODE IS REACHED FOR, and the last two are hidden
    // until they mean something: Object needs more than one object on screen,
    // Entropy needs an MSA. index.html had this order and this hidden Object
    // option; viewer.html had neither, which is the third divergence the two
    // copies had grown.
    [{ kind: 'select', id: 'colorSelect', label: 'Color',
       options: [['auto', 'Auto'], ['rainbow', 'Rainbow'], ['chain', 'Chain'],
                 ['object', 'Object', { hidden: true }], ['ss', 'SSE'],
                 ['plddt', 'pLDDT'], ['deepmind', 'DeepMind'],
                 ['entropy', 'Entropy', { id: 'entropyColorOption', hidden: true }]] }],

    // ...filled by ui.js from py2dmolCartoon.SS_PALETTES, and shown only while
    // the colour mode is 'ss'.
    [{ kind: 'slot', id: 'ssPaletteButtons', label: 'SSE', needsSs: true,
       title: 'Colour palette for the SSE mode;'
            + ' C coil, H helix, E strand, N nucleic, L ligand' }],

    // THE ORDER IS THE LAYOUT, and it is one wrapping flow rather than tidy
    // rows. A cell belonging to the other style collapses and the rest pack
    // themselves, which only reads as whole lines if the cartoon-only ones come
    // FIRST: cartoon gets Smooth/Arrows/Draw then Colorblind/Dark/Cyclic, and
    // tube - which hides the first three - gets the last three on one line.
    // Hand-made rows left tube with Cyclic alone under Colorblind/Dark.
    //
    // NO BASES TOGGLE. Base plates are per-residue and belong to the selection
    // panel, which turns them on and off for what is selected (setBasesFor).
    // A global switch here was a second way to say the same thing, disagreeing
    // with the first the moment either was used.
    [{ kind: 'toggle', id: 'smoothCheckbox', label: 'Smooth', style: 'cartoon',
       title: 'Smooth shading gradients (off = flat tone bands)' },
     { kind: 'toggle', id: 'arrowsCheckbox', label: 'Arrows', style: 'cartoon',
       checked: true,
       title: 'Arrowheads on the C-terminal end of each beta strand' },
     // DRAW IS THE 2D PAINTER'S, and outside the website that painter is
     // usually not in the download at all. _gpuWillTake returns false while
     // drawMode is on - the pencil, the wash and the grain have no WebGL2
     // port - so on a GPU-only build ticking this asks for a painter that is
     // not there. needs2d drops the item rather than the row, because the
     // toggles beside it are nothing to do with the painter.
     { kind: 'toggle', id: 'drawCheckbox', label: 'Draw', style: 'cartoon',
       needs2d: true,
       title: 'Build the picture up by hand: pencil sketch, colour wash, then ink' },
     { kind: 'toggle', id: 'colorblindCheckbox', label: 'Colorblind',
       title: 'Colorblind-safe colors' },
     { kind: 'toggle', id: 'darkCheckbox', label: 'Dark',
       title: 'Black background (white ink, fade toward black)' },
     { kind: 'toggle', id: 'detectCyclicCheckbox', label: 'Cyclic',
       title: 'Join a chain end-to-end when its termini are within bonding range' }],
];

function el(tag, props) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null) continue;
        if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v === true ? '' : String(v));
    }
    return node;
}

/** The caption beside a control. `for` is what makes clicking it focus. */
function caption(item) {
    return el('label', { for: item.kind === 'slot' ? null : item.id,
                         title: item.title, text: item.label + ':' });
}

function buildItem(item) {
    if (item.kind === 'toggle') {
        // ...the toggle FACE is the span after the checkbox, matched by
        // position rather than a class - see the note in viewer.html's CSS.
        const wrap = el('label', { class: 'btn-toggle', title: item.title,
                                   'data-style': item.style });
        wrap.appendChild(el('input', { type: 'checkbox', id: item.id,
                                       checked: item.checked }));
        wrap.appendChild(el('span', { text: item.label }));
        return wrap;
    }
    let control;
    if (item.kind === 'select') {
        control = el('select', { id: item.id, title: item.title });
        for (const [value, text, extra] of item.options) {
            control.appendChild(el('option', Object.assign({ value, text }, extra)));
        }
    } else if (item.kind === 'range') {
        control = el('input', { type: 'range', id: item.id, min: item.min,
                                max: item.max, value: item.value, step: item.step,
                                title: item.title });
    } else {
        control = el('div', { id: item.id,
                              style: 'flex: 1 1 0; min-width: 0; display: flex;'
                                   + ' flex-direction: column; gap: 3px;' });
    }
    if (!item.half) {
        const frag = document.createDocumentFragment();
        frag.appendChild(caption(item));
        frag.appendChild(control);
        return frag;
    }
    const half = el('div', { class: 'half', 'data-style': item.style });
    half.appendChild(caption(item));
    half.appendChild(control);
    return half;
}

/**
 * The panel, as a detached `#stylePanel` element. Hidden; the Style button
 * opens it.
 *
 * A row's data-style is its single item's when they agree - which is how
 * syncStylePanel hides the whole Smooth/Arrows/Bases row in tube without
 * needing the attribute on each toggle.
 */
function buildStylePanel() {
    const panel = el('div', { id: 'stylePanel', hidden: true });
    // WHICH PAINTER IS IN THIS DOWNLOAD IS SETTLED BEFORE THE PANEL IS BUILT,
    // so an item that only one painter can honour is simply not made. This is
    // the same question core/mol.js asks to derive useGPU, and the same one the
    // Save panel asks before offering SVG.
    const has2d = typeof window !== 'undefined' && !!window.py2dmolCartoonPaint;
    for (const all of STYLE_PANEL_ROWS) {
        const items = all.filter((i) => !(i.needs2d && !has2d));
        if (!items.length) continue;
        const styles = new Set(items.map((i) => i.style || ''));
        const row = el('div', {
            class: 'toggle-item',
            'data-style': styles.size === 1 ? [...styles][0] || null : null,
            'data-needs-ss': items.some((i) => i.needsSs) ? true : null,
            hidden: items.some((i) => i.needsSs) ? true : null,
        });
        for (const item of items) row.appendChild(buildItem(item));
        panel.appendChild(row);
    }
    return panel;
}

window.py2dmolPanel = { buildStylePanel, STYLE_PANEL_ROWS };
}());
