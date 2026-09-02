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
// only for that draw path.
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
    // ...AND HOW A SELECTION IS MARKED, BESIDE IT. The two are the same kind of
    // question - what colour is the structure, what colour is the bit you
    // picked - and they are the only two dropdowns after Style, so they pair.
    //
    // It belongs here rather than under Focus: the mark is on EVERY selection
    // (a sequence-strip drag, Select all, a click in any mode), and a setting
    // hidden inside one mode is findable only from inside it. It also leaves
    // Focus a one-click latch rather than a button that means two things.
    // docs/SELECTION_MARK.md has the six treatments this was chosen from.
    [{ kind: 'select', id: 'colorSelect', label: 'Color', half: true,
       options: [['auto', 'Auto'], ['rainbow', 'Rainbow'], ['chain', 'Chain'],
                 ['object', 'Object', { hidden: true }],
                 // ...AND ONE PER SSE PALETTE, expanded by parts/ui.js from
                 // py2dmolCartoon.SS_PALETTES - 'SSE (PyMOL)', 'SSE (Jmol)'.
                 // This used to be one 'SSE' option plus a whole second
                 // control below: a custom dropdown that drew the palette as
                 // five colour chips, because a native <select> cannot colour
                 // its options. It was ninety lines, it was the only control
                 // in the panel that was not a select or a toggle, and every
                 // attempt to make it look like its neighbours found another
                 // way in which it did not. Two options in the dropdown that
                 // is already there say the same thing.
                 ['ss', 'SSE', { id: 'ssColorOption' }],
                 ['hydrophobicity', 'Hydropathy'],
                 ['plddt', 'pLDDT'], ['deepmind', 'DeepMind'],
                 ['entropy', 'Entropy', { id: 'entropyColorOption', hidden: true }]] },
     { kind: 'select', id: 'selectionMarkSelect', label: 'Sele', half: true,
       title: 'How a selected residue is marked: a translucent band over it,'
            + ' a thin outline around it, or nothing.',
       options: [['highlight', 'Highlight'], ['outline', 'Outline'],
                 ['none', 'None']] }],

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
     { kind: 'toggle', id: 'cyclicCheckbox', label: 'Cyclic',
       title: 'Join a chain end-to-end when its termini are within bonding range' }],
     // NO FOCUS ROW. It was one here and it is a top-level BUTTON now, beside
     // Orient and Clip: it is a mode that changes what a click does, and a
     // reader looking for that does not open a style panel to find it.
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
        });
        for (const item of items) row.appendChild(buildItem(item));
        panel.appendChild(row);
    }
    return panel;
}

// ============================================================================
// THE PANEL'S SKIN, AND WHY IT IS HERE RATHER THAN IN A STYLESHEET
// ----------------------------------------------------------------------------
// The Style panel's rule is "one panel, two skins" - the markup is shared and
// each page's own CSS dresses it. That worked because it is a handful of rules
// per shell. This panel is FORTY-SIX, and they lived in src/app/style.css and
// nowhere else - so mounting it in a notebook gave correct markup, working
// verbs and a 340px column of browser-default buttons.
//
// So the skin travels WITH the rows. `SCOPE` in front of every selector is
// what makes it safe to inject into someone else's page: the embed passes its
// container id (`#${id}`, the same scoping SHELL_CSS uses and for the same
// reason), and a page that owns its whole document passes nothing.
// 🔴 EVERY var() CARRIES ITS FALLBACK, and that is not tidiness. These rules
// were src/app/style.css's, where `--btn-radius` and `--color-gray-300` are
// declared on :root a hundred lines above them; viewer.html and the embed's
// shell declare neither, so an unresolved var() is not a default - it is an
// INVALID declaration, dropped. The Show/Hide switch came out with no border,
// no radius and height: auto, which is a browser-default button wearing the
// right class. Measured as `switchRadius: 0` in tests/selection_shells.py.
const SELECTION_PANEL_CSS = `/* SELECTION PANEL. Sits under the right-hand buttons, beside the structure the
   tools act on, and appears only when there is a selection - with nothing
   picked every control in it is a no-op.
   It used to live in the sequence header, which was never quite its home: the
   tools act on the 3D structure rather than on the sequence, and a selection
   can be made by clicking the canvas or the PAE map just as well as by dragging
   the strip. */
SCOPE .selection-panel {
    max-width: 100%;
    box-sizing: border-box;
    /* ...and it is queryable by its own width - see the narrow-column block
       at the foot of this stylesheet. */
    container-type: inline-size;
    /* 🔴 AND IT STATES ITS OWN LINE HEIGHT. viewer.py wraps every notebook
       viewer in "line-height: 0" - which is right for the div holding a canvas,
       because an inline-block leaves a text gap under it, and it INHERITS. The
       row captions came out 74px wide and ZERO high: every row on the panel
       with its controls and no name. Invisible on the website and in the
       embed, because neither has that wrapper. */
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
/* 🔴 A SECTION OF THE CONTROL COLUMN, NOT A CARD ON TOP OF ONE.
   ----------------------------------------------------------------------------
   This panel is a free-standing box on the website, where it has its own ~340px
   column beside the structure and sits among other boxes - the PAE plot, the
   scatter - that look the same. Put into the notebook's 180px control column
   and the embed's 190px one it was a bordered white card INSIDE a bordered
   white card, which is what "it still appears as a separate panel" means from
   the reader's seat: two frames around one stack of controls.

   So the shared form is the COLUMN form - full width, no border, no shadow, no
   ground of its own, and a hairline above to say a new group starts here, which
   is the same rule the panel already uses between its properties and its
   actions.

   AND IT IS AT ZERO SPECIFICITY, so index.html's .container-box (0,1,0) wins
   every one of these - without an ordering, which matters because this block is
   injected at runtime and therefore comes AFTER the page's <link>.

   HONESTLY: that is defence, not a fix for anything currently broken. Removing
   the :where() here changes no pixel today, measured, because the values
   coincide - the card's border-top is the same 1px #e5e7eb as the hairline, its
   padding the same 8px, and the panel's slot on that page is exactly 340px so
   a stated 100% width lands on the number the card used to state. It earns its keep
   the day one of those three stops coinciding, and it costs nothing. What DOES
   bite is the class: dropping container-box from the element below and the
   website loses its card, which tests/selection_panel.py catches in three
   assertions. */
SCOPE :where(.selection-panel) {
    width: 100%;
    border-top: 1px solid #e5e7eb;
    padding-top: 8px;
}
SCOPE .selection-panel[hidden] { display: none; }


SCOPE .selection-panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
}
SCOPE .selection-panel-title {
    font-weight: 600;
    color: #374151;
    font-size: 13px;
}
/* WHAT IS IN PLAY, by name. A count said how many; the ranges say WHICH, which
   is what you check before pressing anything - and the count is still there in
   front of them. Truncated with an ellipsis rather than wrapped, so the head
   stays one line however wide the selection is; the whole list is in the title. */
SCOPE .selection-panel-count {
    font-size: 12px;
    color: #6b7280;
    font-variant-numeric: tabular-nums;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
/* The panel's own actions, as icons in the corner: they act on the selection as
   a whole rather than on one part of it, and they are the two that are hard to
   undo. */
SCOPE .selection-panel-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
}
SCOPE .selection-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fff;
    color: #6b7280;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
}
SCOPE .selection-icon-btn:hover {
    background: var(--color-gray-200, #e5e7eb);
    color: #374151;
}
SCOPE .selection-icon-danger:hover {
    background: #fee2e2;
    border-color: #fecaca;
    color: #b91c1c;
}
/* Selection tools: act on the residues currently selected. Stacked as labelled
   rows - Side chains, Main chain - because the two parts are independent and a
   flat row of buttons gives no clue which button touches which. */
SCOPE .selection-tools {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
SCOPE .selection-panel-row {
    display: flex;
    flex-wrap: wrap;
    /* 4: the least that still reads as separate buttons. It was 6, and then 5
       while the row was fighting for pixels it did not actually need. */
    gap: 4px;
    align-items: center;
}
SCOPE .selection-panel-row[hidden] { display: none; }
/* 🔴 EACH CONTROL IS ITS OWN ROUNDED BUTTON, AND THE ROW IS ONE LINE.
   ----------------------------------------------------------------------------
   Show/Hide, Plate and Elem were briefly one segmented strip - a single border
   round the group with the segments flat inside it - so they would fit without
   the row wrapping. They fitted, and they read as PARTIAL BUTTONS: the pair
   kept a rounded box of its own while Plate came out a square block with no
   border and Elem square on one side, which is three different kinds of thing
   touching.
   They are ordinary buttons again. What buys the width instead is padding and
   a shorter caption, both of which are just numbers - and the row still comes
   out on one line, which is the whole requirement. */
/* PROPERTIES ABOVE, ACTIONS BELOW. A hairline the full width of the panel:
   the rows are already small and closely stacked, so anything heavier reads as
   two panels rather than as a break in one list. */
SCOPE .selection-panel-divider {
    height: 1px;
    background: #e5e7eb;
    margin: 3px 0 3px 0;
}
SCOPE .selection-panel-divider[hidden] { display: none; }
/* Fixed width so the two rows' controls line up under each other; without it
   "Side chains" and "Main chain" push their buttons to different columns and
   the pairing stops being legible at a glance. */
SCOPE .selection-panel-label {
    /* 🔴 62, AND IT USED TO BE 74. Fixed, so the rows line up under each other -
       without that, "Side chains" and "Main chain" push their buttons to
       different columns and the pairing stops being legible at a glance. The
       NUMBER is what the widest caption needs and no more: "Side chains" measures
       65px on this page, "Main chain" 61, "Find" 25 - MEASURED, by cloning the
       label and letting it size itself, because a fixed box that the text has
       already wrapped inside reports the box.
       🔴 IT IS 74 AGAIN. It was cut to 66, and the pair's and the toggles' own
       padding with it, to win the pixels a five-control row needed - all three
       of them fudges against a row that was 46px wider than it looked because
       each toggle's LABEL carried 10px a side outside its own face. With that
       gone the row has 46px to spare and none of the trims are needed. */
    width: 74px;
    flex: 0 0 74px;
    /* ...and it never wraps: too narrow has to show as text running out of its
       box, not as a row that quietly doubles in height. */
    white-space: nowrap;
    font-size: 12px;
    color: #4b5563;
}
/* SELECTION TOGGLES. These rows used a +/- pair each: two buttons to express
   one binary, and no way to see which way it currently stood - a selection
   already showing its side chains looked exactly like one that was not. A
   toggle carries the state in its own face, grey for off and green for on, the
   same as every other toggle on the page, and halves the controls in a 340px
   panel.
   Sized to leave room for two on the side-chain row (Show and Elements)
   without wrapping. */
SCOPE .selection-toggle {
    flex: 0 0 auto;
    /* 🔴 NO PADDING ON THE LABEL, AND NO 54px FLOOR. This is a <label> whose
       visible face is the span inside it - the checkbox is invisible - so
       padding here is space OUTSIDE the button that still belongs to it, and
       the shells give it 10px a side. Two of those between Plate and Elem plus
       the row's own gap is 25px of air between two buttons that are 42 and 41
       wide: reported as a large gap, and invisible in the markup because the
       box measures 62 while the thing you can see measures 42.
       The floor went the same way - it padded a 42px button out to 54 with
       nothing in the extra 12. The face carries its own padding; the box is
       the face. */
    padding: 0;
    min-width: 0;
}
/* SHOW / HIDE, as one control: two buttons that share a border and answer one
   question between them. The one that matches what is DRAWN is filled, so the
   pair says both what it will do and what it has done - a single switch could
   only say the first, which is what made this panel hard to read. Neither is
   filled when the selection disagrees with itself. */
SCOPE .selection-switch {
    display: inline-flex;
    flex: 0 0 auto;
    border: 1px solid var(--color-gray-300, #d1d5db);
    border-radius: var(--btn-radius, 6px);
    overflow: hidden;
    height: var(--btn-height-small, 26px);
}
SCOPE .selection-switch[hidden] { display: none; }
SCOPE .selection-switch-btn {
    appearance: none;
    border: 0;
    background: #fff;
    color: var(--color-gray-600, #4b5563);
    font-size: var(--btn-font-size-small, 12px);
    font-weight: 600;
    padding: 0 7px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
SCOPE .selection-switch-btn + .selection-switch-btn {
    border-left: 1px solid var(--color-gray-300, #d1d5db);
}
SCOPE .selection-switch-btn:hover { background: var(--color-gray-100, #f3f4f6); }
/* THE STATE, on the face of the button that matches it. */
SCOPE .selection-switch-btn.is-on {
    background: var(--color-primary, #3b82f6);
    color: #fff;
}
SCOPE .selection-switch-btn.is-on:hover { background: var(--color-primary-hover, #2563eb); }
SCOPE .selection-toggle > span {
    padding: 0 8px;
}
/* Mixed selection: some of what was picked has it, some does not. Neither on
   nor off is true, and showing either is a lie that the next click makes
   worse - so it reads as its own state, and the click resolves it by turning
   everything ON. */
SCOPE .selection-toggle input:indeterminate + span {
    background: repeating-linear-gradient(135deg,
        #e5e7eb, #e5e7eb 4px, #d1d5db 4px, #d1d5db 8px);
    color: #4b5563;
}
/* SSE shares the main-chain row with its Show toggle, the way Elements shares
   the side-chain row - so it is sized to the toggle rather than to its own
   content, or the two rows would end at different places. */
SCOPE #selSsSelect {
    flex: 0 1 auto;
    min-width: 54px;
    /* ...AND IT MAY SHRINK. A Show/Hide pair is half as wide again as the
       switch it replaced, and this select's content ("DSSP", "Helix") had it
       asking for 121px of a 314px row - which pushed the row onto two lines.
       It is the one control here that can lose width without losing meaning,
       since its job is to show one short word. */
    max-width: 84px;
}
/* ADD, on a row that has nothing on it yet. A plain button rather than half a
   pair: until the contact exists there is no state to show, and once it does
   the button is gone. */
SCOPE .selection-add {
    flex: 0 0 auto;
}
/* ...AND THE BIN, at the end of that contact's own controls. Ghosted until
   hovered, like the panel head's icons: a destructive action that does not
   advertise itself. */
SCOPE .selection-tools .selection-icon-btn {
    flex: 0 0 auto;
    /* the head's icons are 24px squares in a 28px row; on a control row it
       lines up with the switches beside it */
    height: var(--btn-height-small, 26px);
    width: var(--btn-height-small, 26px);
}
SCOPE .selection-tools .selection-icon-btn[hidden] { display: none; }
/* Per-contact width. Narrow enough to share a row with a swatch and two
   buttons, which is the whole reason it is a slider and not a number box. */
SCOPE .selection-mini-slider {
    width: 64px;
    flex: 0 0 64px;
    margin: 0;
}
SCOPE .selection-mini-slider[hidden] { display: none; }
/* An empty swatch means the selection has no single colour to show - nothing
   selected, or the renderer could not resolve one. A hollow square reads as
   "no answer"; a filled one would be a claim. */
SCOPE .selection-swatch.is-empty {
    background: transparent !important;
    border-style: dashed;
}
SCOPE .selection-tools.disabled {
    opacity: 0.45;
    pointer-events: none;
}
/* Colour button carries a swatch of the current colour, and opens a grid of
   PyMOL's named colours. Anchored on a positioned wrapper so the popup floats
   without the row growing - which matters more now the tools wrap: a popup in
   flow would reflow the whole panel every time it opened. */
SCOPE .selection-color-wrap {
    position: relative;
    display: inline-flex;
}
/* Swatch only, no word - see the markup. A button whose whole content is a
   14px square would collapse to a sliver at the default padding, so it gets a
   square footprint of its own and grows the swatch to carry the click. */
SCOPE .selection-color {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    width: 30px;
}
SCOPE .selection-color .selection-swatch {
    width: 18px;
    height: 18px;
}
SCOPE .selection-swatch {
    width: 14px;
    height: 14px;
    border: 1px solid #9ca3af;
    border-radius: 3px;
    background: #FF0000;
    flex-shrink: 0;
}
SCOPE .selection-color-menu {
    position: absolute;
    /* Opens DOWNWARD and left-aligned. It used to open upward because it sat
       at the bottom of the page under the sequence strip; in the selection
       panel there is room below and the button is at the panel's top-left, so
       upward would have taken it off over the style controls. */
    top: 100%;
    left: 0;
    margin-top: 4px;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    padding: 6px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 3px;
}
SCOPE .selection-color-menu[hidden] { display: none; }
SCOPE .selection-color-row {
    display: flex;
    gap: 3px;
}
SCOPE .selection-color-cell {
    width: 16px;
    height: 16px;
    border: 1px solid rgba(0, 0, 0, 0.25);
    border-radius: 3px;
    padding: 0;
    cursor: pointer;
}
/* THE MODE LIST, sized like the panel's own controls rather than like a
   swatch: it is a <select> among squares, and at the cells' 16px it would be
   unreadable. Full width of the menu so it reads as the row it is. */
SCOPE .selection-color-mode {
    flex: 1;
    height: 24px;
    font-size: 12px;
    padding: 0 6px;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f9fafb;
    color: #374151;
    cursor: pointer;
}
SCOPE .selection-color-mode:hover {
    background: #eef2ff;
    border-color: #6366f1;
}
SCOPE .selection-color-auto {
    flex: 1;
    font-size: 11px;
    line-height: 1.6;
    padding: 1px 6px;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f9fafb;
    color: #374151;
    cursor: pointer;
    white-space: nowrap;
}
SCOPE .selection-color-auto:hover {
    background: #eef2ff;
    border-color: #6366f1;
}
SCOPE .selection-color-cell:hover {
    outline: 2px solid #111827;
    outline-offset: 1px;
}
/* ==========================================================================
   THE PANEL'S OWN CONTROL BASE, AT ZERO SPECIFICITY.
   --------------------------------------------------------------------------
   The rows are built with the website's classes - "btn btn-grey btn-small",
   "btn-toggle", "container-box" - and the website is the only shell that
   defines them. viewer.html and the embed's shell have ".btn-toggle" and
   nothing else, so the panel arrived there with correct markup and unstyled
   controls: a 340px column of browser-default buttons.

   :where() IS WHAT MAKES THIS SAFE. It carries ZERO specificity, so the
   website's own ".btn" (0,1,0) wins every one of these without needing an
   order or an !important - which is why moving the skin here could be proved
   a no-op on the site it came from - while a shell that defines none of them
   gets a control that looks like the panel it is on.
   ========================================================================== */
/* NO CARD HERE. There was one - a :where() copy of .container-box, so a shell
   with no such class still got a bordered white box - and that was the wrong
   default: in a control column it is a frame inside a frame. The card is
   index.html's, from its own stylesheet, and the shared form is the section
   above. */
SCOPE :where(.selection-panel) :where(.btn) {
    height: 30px;
    padding: 0 14px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    border: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    color: white;
    text-align: center;
    font-family: inherit;
}
SCOPE :where(.selection-panel) :where(.btn-small) {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    line-height: 26px;
}
SCOPE :where(.selection-panel) :where(.btn-grey) {
    background: #e5e7eb;
    color: #374151;
}
/* The toggle: the checkbox is invisible and the span after it is the face.
   Matched by POSITION rather than by a class - see the note in viewer.html's
   own stylesheet, which does the same. */
SCOPE :where(.selection-panel) :where(.btn-toggle) {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
}
SCOPE :where(.selection-panel) :where(.btn-toggle) :where(input) {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
}
SCOPE :where(.selection-panel) :where(.btn-toggle) :where(input:checked + span) {
    background: #d1d5db;
    color: #111827;
    border-color: #9ca3af;
}

/* ==========================================================================
   THE NARROW COLUMN, MEASURED AGAINST THE CONTROLS ALREADY IN IT.
   --------------------------------------------------------------------------
   index.html gives this panel a 340px card; viewer.html's control column is
   180px wide and the embed's 190. In those the rows came out on two and three
   lines, and every control was the wrong size beside the shell's own:

                        the shell's      the panel's
       row caption        52px             74px
       select/button      24px high        26px
       toggle face        22px high        26px

   ...which is what "the buttons are not on the same row, and the style differs
   from the others" is. Both halves are the same cause: this panel was sized for
   its own 340px column and put into someone else's 180px one.

   A CONTAINER QUERY, NOT A PER-SHELL COPY. The constraint is the panel's own
   WIDTH, so that is what is asked - one rule, no numbers duplicated into
   viewer.html and parts/embed.js to fall out of step, and it is right for a
   shell that has not been written yet. container-type: inline-size is on the
   panel above.

   🔴 AND IT IS THE LAST THING IN THIS STYLESHEET, WHICH IS NOT TIDINESS. Its
   declarations are the same specificity as the ones they replace, so ordering
   is the only thing that decides them - written where the block first went,
   above the rules it overrides, the heights took (nothing else set those) and
   the caption width and the switch height did not. Half a restyle, and it
   looked like the container query was not matching.
   ========================================================================== */
@container (max-width: 260px) {
    /* The caption is the shell's 52px, which is what makes a row fit at all:
       52 + 30 + a pair is inside 172px where 74 + 30 + a pair is not. */
    /* 🔴 THE CAPTION IS BACK ON THE ROW. It was given a line of its own here,
       because a caption, a swatch and a Show/Hide pair did not fit 172px - and
       they did not fit only because each control carried 10px a side of label
       padding outside its own face. With that gone the three measure 171, so
       the row is ONE LINE again and the panel loses 19px per row: 193px tall
       to 136. Same width the card uses, and it is what the widest caption
       needs: "Side chains" is 59px in viewer.html's font and 65 in the
       embed's. */
    SCOPE .selection-panel-label { width: 66px; flex: 0 0 66px; }
    /* ...and every control drops to the shell's own 24px, with its toggle face
       at 22, so the panel reads as more of the same column rather than as
       something pasted into it. */
    SCOPE .selection-switch { height: var(--ctl-h, 24px); }
    SCOPE .selection-add,
    SCOPE .selection-panel-row .btn-small { height: var(--ctl-h, 24px); }
    SCOPE #selSsSelect { height: var(--ctl-h, 24px); max-width: 64px; min-width: 0; }
    SCOPE .selection-toggle > span { height: 22px; line-height: 22px; }
    SCOPE .selection-color { height: var(--ctl-h, 24px); width: 24px; }
    /* 🔴 AND WHAT MAKES THE ROW FIT IS PADDING, NOT FLEX - measured. A
       flex: 0 1 auto on the switch was written here first, on the reasoning
       that a control which would rather WRAP than lose four pixels is the
       problem; removing it again changes nothing, because with the caption on
       its own line the controls already fit. What does not fit without these
       two is the main-chain row: at the card's 7px button padding and 30px
       swatch its select drops to a third line, which is what M6 and M7 in the
       probe's mutation set say.
       Only these three numbers, then - no defensive flex that measures as
       inert. */
    SCOPE .selection-switch-btn { padding: 0 3px; min-width: 0; }
    SCOPE .selection-toggle { min-width: 0; }
    /* ...AND THE "WHICH WAY" CONTROLS GET THEIR OWN LINE, ALIGNED UNDER THE
       PAIR. A zero-height item at full width is how a wrapping flex row is told
       where to break; the indent is the swatch plus the gap, so Plate and Elem
       start at the left edge of Show rather than under the colour button, which
       is what they read as belonging to. */
    /* 3, against the card's 4. The notebook's row is 170px wide and a caption,
       a swatch and the pair want 171 at a 4px gap - ONE pixel, and the whole
       difference between a row on one line and a row on two. */
    SCOPE .selection-panel-row { gap: 3px; }
    /* ...and the rows sit closer together, since each is one line now and a
       gap sized for two-line blocks reads as slack between them.
       🔴 THE PANEL'S OWN gap AND padding ARE NOT HERE, AND CANNOT BE. An
       element cannot query the container it establishes - container-type on
       .selection-panel makes it a container for its DESCENDANTS - so a rule for
       .selection-panel inside this block matches nothing at all. Written here
       first and measured as no change: the panel's gap stayed 8px while every
       rule around it took. */
    SCOPE .selection-tools { gap: 4px; }
}
`;

/**
 * The panel's stylesheet, with every selector under `scope`.
 * Pass an id selector to confine it (an embed inside a host page); pass
 * nothing where the document is the panel's own.
 */
function selectionPanelCSS(scope) {
    return SELECTION_PANEL_CSS.replace(/\bSCOPE\b/g, scope || '');
}

/**
 * ...and inject it, once per scope. Keyed by the scope rather than by a fixed
 * id, because two embeds on one page are two scopes and each needs its own.
 */
function installSelectionPanelCSS(scope) {
    const key = 'py2dmol-selection-css' + (scope ? '-' + scope.replace(/\W/g, '') : '');
    if (document.getElementById(key)) return;
    const style = document.createElement('style');
    style.id = key;
    style.textContent = selectionPanelCSS(scope);
    document.head.appendChild(style);
}

// ============================================================================
// THE SELECTION PANEL, ONCE (buildSelectionPanel)
// ----------------------------------------------------------------------------
// The same move this file already made for the Style panel, one panel along.
// It was two hundred lines of markup in index.html and nowhere else, so the
// notebook and the embed had `parts/selectpanel.js`'s verbs in the download and
// no control that could reach them - the shape of gap clip, orient, focus and
// the side chains each came back from.
//
// THE IDS ARE THE CONTRACT. Every verb in parts/selectpanel.js looks its own
// DOM up by `getElementById`, so what makes them portable is that these ids are
// the same in whichever shell mounted the panel. Renaming one here is renaming
// it there.
//
// 🔴 AND THE ICONS ARE INLINE SVG, NOT A FONT. index.html loads Font Awesome
// and `viewer.html` and the embed's shell do not, so `<i class="fa-solid
// fa-trash-can">` is a bin on the website and an EMPTY SQUARE THAT DELETES
// THINGS everywhere else. tests/selection_panel.py already had that rule and
// checked it as a font family, which is the one spelling that cannot travel.
// Three paths, ~600 bytes, and the button carries its own ink.
const ICONS = {
    copy: '<path d="M4 2h7l3 3v9H4z" fill="none" stroke="currentColor"'
        + ' stroke-width="1.4"/><path d="M2 5v9h7" fill="none"'
        + ' stroke="currentColor" stroke-width="1.4"/>',
    scissors: '<circle cx="4" cy="12.5" r="2.2" fill="none" stroke="currentColor"'
        + ' stroke-width="1.4"/><circle cx="12" cy="12.5" r="2.2" fill="none"'
        + ' stroke="currentColor" stroke-width="1.4"/><path d="M5.5 11L13 2M10.5'
        + ' 11L3 2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    trash: '<path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 10h5.6l.7-10" fill="none"'
        + ' stroke="currentColor" stroke-width="1.4"/>',
};

/** An icon button's ink, as an <svg> the shell does not have to provide. */
function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICONS[name];
    return svg;
}

// THE HEAD'S THREE ACTIONS, as icons in the corner. Copy used to be a
// full-width button at the foot of the panel, where it sat under the pointer
// after every other control and was pressed by accident.
//
// CUT is Copy and Delete in one press and has to be: Copy switches to the
// object it makes and Delete works on whatever is current, so pressing them in
// turn deletes the copy out of itself and leaves the original whole.
const SELECTION_ACTIONS = [
    { id: 'copySelectionButton', icon: 'copy',
      title: 'Copy the selected residues into a new object',
      aria: 'Copy the selection into a new object' },
    { id: 'cutSelectionButton', icon: 'scissors',
      title: 'Cut the selected residues into a new object,'
           + ' removing them from this one',
      aria: 'Cut the selection into a new object' },
    { id: 'deleteSelectionButton', icon: 'trash', danger: true,
      title: 'Delete the selected residues from this object',
      aria: 'Delete the selected residues' },
];

// WHAT IS DRAWN, one labelled row per part, because the two are independent: a
// residue can show its main chain, its side chain, both or neither.
//
// Show and Hide are two BUTTONS rather than one switch. A switch says what it
// will do and leaves you to work out what it has done; a pair says both,
// because the one matching what is drawn is filled - and a selection that
// disagrees with itself fills neither, which is a state a switch can only show
// as a grey smear. Plate and Elem stay switches: they are not "is this drawn"
// but "which way", and a second pair on the same row would read as a second
// copy of the same question.
//
// Kinds here, beside the Style panel's four: 'color' (a swatch button and the
// menu it opens - three ids from one), 'pair' (the two buttons above),
// 'button', 'range', 'select', 'toggle'.
const SELECTION_PANEL_ROWS = [
    // Hidden when the selection has no side chains to show - all glycine,
    // nucleic acid, or a backbone-only model. See hasSidechainsFor.
    { id: 'sidechainRow', label: 'Side chains', items: [
        // THE SWATCH IS THE LABEL: a coloured square next to Show/Hide reads as
        // "colour" without saying so, and the word cost a third of the row in a
        // 340px panel. aria-label because there is no text left - `title` is
        // only a fallback for an accessible name.
        { kind: 'color', id: 'scColor',
          title: 'Colour the selected side chains',
          aria: 'Colour the selected side chains' },
        { kind: 'pair', id: 'sidechainPair',
          aria: 'Draw side chains for the selected residues', buttons: [
            { id: 'sidechainShowButton', label: 'Show',
              title: 'Draw side chains for the selected residues' },
            { id: 'sidechainHideButton', label: 'Hide',
              title: 'Hide the side chains of the selected residues' }] },
        // ...AND HOW, FOR A NUCLEOTIDE, which is the only thing with two ways
        // of being drawn: the plate or its real atoms.
        { kind: 'toggle', id: 'plateShowToggle', label: 'Plate',
          title: 'Draw the bases as plates rather than atoms',
          aria: 'Draw the selected bases as plates' },
        // Element colours ride WITH the side chains rather than in a row of
        // their own: they are a property of the atoms this row draws. "Elem",
        // not "Elements" - the full word pushed the row onto a second line.
        { kind: 'toggle', id: 'elementsShowToggle', label: 'Elem',
          title: 'Colour the selected atoms by element'
               + ' - nitrogen blue, oxygen red, sulfur gold',
          aria: 'Colour the selected atoms by element' },
    ] },
    { id: 'mainchainRow', label: 'Main chain', items: [
        { kind: 'color', id: 'selColor',
          title: 'Colour the selected residues (PyMOL palette)',
          aria: 'Colour the selected residues' },
        // SHOW IS THE CHAIN, and nothing else. A residue with no chain and no
        // side chain draws nothing, and drops out of the visibility mask on
        // its own.
        { kind: 'pair', id: 'mainchainPair',
          aria: 'Draw the backbone of the selected residues', buttons: [
            { id: 'mainchainShowButton', label: 'Show',
              title: 'Draw the backbone of the selected residues' },
            { id: 'mainchainHideButton', label: 'Hide',
              title: 'Hide the backbone. Their side chains, bases and'
                   + ' contacts stay.' }] },
        // SSE lives HERE because it is a BACKBONE property: a side chain has
        // no secondary structure.
        //
        // A STATE, NOT AN ACTION. It read "SSE" whatever the selection was,
        // because it reset itself after every pick - so the one thing a menu on
        // a selection panel is for, saying what the selection currently is, was
        // the one thing it did not do. DSSP rather than Auto: the automatic
        // answer is not a preference, it is what the assignment says.
        { kind: 'select', id: 'selSsSelect',
          title: 'The secondary structure of the selected residues',
          options: [['', 'Mixed', { disabled: true, hidden: true }],
                    ['dssp', 'DSSP'], ['H', 'Helix'],
                    ['E', 'Sheet'], ['C', 'Loop']] },
    ] },
    // WHAT THE SELECTION IS, above; WHAT TO DO WITH IT, below. The rows above
    // set properties of the residues you picked and read as a group because
    // they all answer "what does this look like". Find, Align and Contact do
    // something instead.
    { divider: 'selActionDivider' },
    // FIND INTERACTIONS: the residues whose SIDE CHAINS come within 5 A of the
    // selection, atom to atom. One button and no settings. The seed stays
    // selected, as PyMOL's byres does.
    { id: 'nearbyRow', label: 'Find', items: [
        { kind: 'button', id: 'selectNearby', label: 'interactions',
          title: 'Select every residue whose side chain comes within'
               + ' 5 Å of the selection' },
    ] },
    // ALIGN: superpose other objects onto the SELECTED RESIDUES by TM-align.
    // A dropdown and not two buttons - "all" and "visible" are the same action
    // over different sets, and Undo is the third thing you can do to an
    // alignment.
    //
    // 🔴 IT NEEDS `align/align.js`, WHICH IS IN NO BUNDLE - it finds its own
    // URL to start its Worker, so it can never be concatenated. The row is
    // built everywhere and syncAlignRow hides it when `window.Align` is absent,
    // which is the same shape as the Style panel's Draw item: a control the
    // shared panel shows and no shell can honour is worse than no control.
    { id: 'alignRow', label: 'Align', hidden: true, items: [
        { kind: 'select', id: 'alignSelect',
          title: 'Superpose other objects onto the selected residues (TM-align)',
          options: [['', 'to selection', { selected: true, hidden: true }],
                    ['all', 'all to this'], ['visible', 'visible to this'],
                    ['none', 'undo']] },
    ] },
    // CONTACTS need exactly two residues, so this row appears only then - a
    // contact is a line between a pair and there is nothing to draw for one
    // residue or for five.
    { id: 'contactRow', label: 'Contact', hidden: true, items: [
        { kind: 'color', id: 'contactColor',
          title: 'Colour the contact between the selected residues',
          aria: 'Colour the contact between the selected residues' },
        // ADD, not Show: a contact does not exist until you make one, and once
        // it does the button has nothing left to offer - so it goes, and the
        // row becomes the contact's own controls.
        { kind: 'button', id: 'contactAddButton', label: 'Add',
          cls: 'selection-add',
          title: 'Draw a contact between the two selected residues' },
        // Per contact, not global. FULL WIDTH IS THE MAXIMUM: the slider only
        // takes a contact down from the width it is drawn at - an annotation
        // that can outweigh the structure it annotates is not useful.
        { kind: 'range', id: 'contactWidthSlider', cls: 'selection-mini-slider',
          min: 0.15, max: 1, step: 0.05, value: 1, hidden: true,
          title: 'Width of this contact (full width is the maximum)',
          aria: 'Width of this contact' },
        // ...AND THE BIN, at the end of the row, where a destructive action is
        // a deliberate reach rather than the button next to the one you were
        // just pressing.
        { kind: 'iconbtn', id: 'contactDeleteButton', icon: 'trash',
          danger: true, hidden: true, title: 'Remove this contact',
          aria: 'Remove the contact between the two selected residues' },
    ] },
];

function buildSelectionItem(item) {
    if (item.kind === 'color') {
        const wrap = el('span', { class: 'selection-color-wrap' });
        const btn = el('button', { type: 'button', id: item.id + 'Button',
            class: 'btn btn-grey btn-small selection-color',
            title: item.title, 'aria-label': item.aria });
        btn.appendChild(el('span', { id: item.id + 'Swatch',
                                     class: 'selection-swatch' }));
        wrap.appendChild(btn);
        wrap.appendChild(el('div', { id: item.id + 'Menu',
                                     class: 'selection-color-menu', hidden: true }));
        return wrap;
    }
    if (item.kind === 'pair') {
        const wrap = el('span', { class: 'selection-switch', id: item.id,
                                  role: 'group', 'aria-label': item.aria });
        for (const b of item.buttons) {
            wrap.appendChild(el('button', { type: 'button', id: b.id,
                class: 'selection-switch-btn', title: b.title, text: b.label }));
        }
        return wrap;
    }
    if (item.kind === 'toggle') {
        const wrap = el('label', { class: 'btn-toggle btn-small selection-toggle',
                                   title: item.title });
        wrap.appendChild(el('input', { type: 'checkbox', id: item.id,
                                       'aria-label': item.aria }));
        wrap.appendChild(el('span', { text: item.label }));
        return wrap;
    }
    if (item.kind === 'iconbtn') {
        const btn = el('button', { type: 'button', id: item.id,
            class: 'btn btn-grey btn-small selection-icon-btn'
                 + (item.danger ? ' selection-icon-danger' : ''),
            hidden: item.hidden, title: item.title, 'aria-label': item.aria });
        btn.appendChild(icon(item.icon));
        return btn;
    }
    if (item.kind === 'select') {
        const sel = el('select', { id: item.id, class: 'btn btn-grey btn-small',
                                   title: item.title });
        for (const [value, text, extra] of item.options) {
            sel.appendChild(el('option', Object.assign({ value, text }, extra)));
        }
        return sel;
    }
    if (item.kind === 'range') {
        return el('input', { type: 'range', id: item.id, class: item.cls,
            min: item.min, max: item.max, step: item.step, value: item.value,
            hidden: item.hidden, title: item.title, 'aria-label': item.aria });
    }
    return el('button', { id: item.id,
        class: 'btn btn-grey btn-small' + (item.cls ? ' ' + item.cls : ''),
        title: item.title, text: item.label });
}

/**
 * The panel, as a detached `#selectionPanel` element. Hidden; a selection is
 * what opens it, and updateSelectionToolsState in parts/selectpanel.js is what
 * decides which rows are on it.
 */
function buildSelectionPanel() {
    const panel = el('div', { id: 'selectionPanel',
                              class: 'container-box selection-panel', hidden: true });
    const head = el('div', { class: 'selection-panel-head' });
    head.appendChild(el('span', { class: 'selection-panel-title', text: 'Selection' }));
    head.appendChild(el('span', { id: 'selectionPanelCount',
                                  class: 'selection-panel-count' }));
    const actions = el('span', { class: 'selection-panel-actions' });
    for (const a of SELECTION_ACTIONS) {
        const btn = el('button', { id: a.id,
            class: 'selection-icon-btn' + (a.danger ? ' selection-icon-danger' : ''),
            title: a.title, 'aria-label': a.aria });
        btn.appendChild(icon(a.icon));
        actions.appendChild(btn);
    }
    head.appendChild(actions);
    panel.appendChild(head);

    const tools = el('div', { id: 'selectionTools', class: 'selection-tools',
                              title: 'Applies to the selected residues' });
    for (const row of SELECTION_PANEL_ROWS) {
        if (row.divider) {
            tools.appendChild(el('div', { class: 'selection-panel-divider',
                                          id: row.divider }));
            continue;
        }
        const node = el('div', { class: 'selection-panel-row', id: row.id,
                                 hidden: row.hidden });
        node.appendChild(el('span', { class: 'selection-panel-label',
                                      text: row.label }));
        for (const item of row.items) node.appendChild(buildSelectionItem(item));
        tools.appendChild(node);
    }
    panel.appendChild(tools);
    return panel;
}

window.py2dmolPanel = { buildStylePanel, STYLE_PANEL_ROWS,
                        buildSelectionPanel, SELECTION_PANEL_ROWS,
                        SELECTION_ACTIONS,
                        selectionPanelCSS, installSelectionPanelCSS };
}());
