/* What a COPY of part of a structure carries with it:
 *
 *   node tests/copy_selection.js
 *
 * Frames are extracted position by position and that has its own coverage.
 * This is everything else - the per-object display state that says which of
 * those positions are drawn with a side chain or a base, what colour they were
 * given, and which pairs are joined by a contact. All of it is keyed by
 * POSITION INDEX, so a copy has to renumber it and drop what fell outside the
 * selection; none of it was carried at all, so copying a posed selection gave
 * back a bare backbone.
 *
 * `_remapObjectState` is lifted out of viewer-mol.js as source text rather
 * than reimplemented - a paraphrase of a renumbering agrees with itself
 * forever.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'py2Dmol/resources/viewer-mol.js'), 'utf8');

// ---- lift the method --------------------------------------------------------
function liftMethod(name) {
    const at = SRC.indexOf(`        ${name}(src, dst, selectedIndices) {`);
    if (at < 0) throw new Error(`${name} moved or changed signature - nothing here scores it`);
    let depth = 0;
    let k = SRC.indexOf('{', at);
    const body = k;
    for (; k < SRC.length; k++) {
        if (SRC[k] === '{') depth++;
        else if (SRC[k] === '}' && !--depth) break;
    }
    return new Function('src', 'dst', 'selectedIndices',
        `return (function () {${SRC.slice(body + 1, k)}}).call(this);`);
}
const remapRaw = liftMethod('_remapObjectState');

// A stub `this`: the chain/residue lookup the contact filter needs.
const CHAINS = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'];
const RESNUM = [1, 2, 3, 4, 1, 2, 3, 4];
const remap = (src, dst, sel) =>
    remapRaw.call({ chains: CHAINS, residueNumbers: RESNUM }, src, dst, sel);

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('PASS', name); }
    catch (e) { failures++; console.log('FAIL', name, '-', e.message); }
}
const list = (s) => (s instanceof Set ? [...s].sort((a, b) => a - b) : s);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Selection: positions 1,2,3 of chain A and 5 of chain B -> new 0,1,2,3
const SEL = [1, 2, 3, 5];

test('position sets renumber, and what fell outside the selection is dropped', () => {
    const src = {
        sidechains: new Set([0, 2, 3, 7]),   // 0 and 7 are not in the copy
        elements: new Set([3]),
        bases: new Set([5]),
    };
    const dst = {};
    remap(src, dst, SEL);
    if (!eq(list(dst.sidechains), [1, 2])) {
        throw new Error('sidechains came out ' + JSON.stringify(list(dst.sidechains))
            + ' - want [1,2] (old 2 and 3 renumbered)');
    }
    if (!eq(list(dst.elements), [2])) throw new Error('elements ' + JSON.stringify(list(dst.elements)));
    if (!eq(list(dst.bases), [3])) throw new Error('bases ' + JSON.stringify(list(dst.bases)));
});

test('an emptied set stays an empty Set, because null means ALL for two of them', () => {
    // sidechains: null = none. bases/elements: null = ALL. Collapsing an empty
    // result to null therefore inverts two of the three - a copy that selected
    // none of the based nucleotides would come back with every base drawn.
    const src = {
        sidechains: new Set([0]),
        elements: new Set([0]),
        bases: new Set([0]),
    };
    const dst = {};
    remap(src, dst, SEL);
    for (const key of ['sidechains', 'elements', 'bases']) {
        if (!(dst[key] instanceof Set)) {
            throw new Error(`${key} became ${dst[key]} instead of an empty Set`);
        }
        if (dst[key].size !== 0) throw new Error(`${key} is not empty`);
    }
});

test('a field the source never had is not invented on the copy', () => {
    const dst = {};
    remap({}, dst, SEL);
    for (const key of ['sidechains', 'elements', 'bases', 'sidechainColor', 'contacts']) {
        if (key in dst) throw new Error(`${key} appeared on a copy of an object without it`);
    }
});

test('side-chain colours follow their residue', () => {
    const src = { sidechainColor: { 2: '#ff0000', 5: '#00ff00', 7: '#0000ff' } };
    const dst = {};
    remap(src, dst, SEL);
    if (!eq(dst.sidechainColor, { 1: '#ff0000', 3: '#00ff00' })) {
        throw new Error('got ' + JSON.stringify(dst.sidechainColor)
            + ' - want the two inside the selection, renumbered');
    }
});

test('a colour map with nothing left becomes null, not an empty object', () => {
    const dst = {};
    remap({ sidechainColor: { 7: '#ff0000' } }, dst, SEL);
    if (dst.sidechainColor !== null) {
        throw new Error('got ' + JSON.stringify(dst.sidechainColor));
    }
});

test('index-form contacts renumber, and a pair with one end outside is dropped', () => {
    const src = { contacts: [[1, 3, 0.5], [2, 7, 1.0], [3, 5, 0.8, { r: 1, g: 2, b: 3 }]] };
    const dst = {};
    remap(src, dst, SEL);
    if (!eq(dst.contacts, [[0, 2, 0.5], [2, 3, 0.8, { r: 1, g: 2, b: 3 }]])) {
        throw new Error('got ' + JSON.stringify(dst.contacts));
    }
});

test('chain-and-residue contacts survive untouched, but only if both ends do', () => {
    // This form names residues rather than indices, so it needs no renumbering
    // - but a pair whose partner did not come along resolves to nothing on
    // every frame load and warns to the console for the life of the object.
    const src = { contacts: [['A', 2, 'B', 2, 1.0], ['A', 2, 'B', 4, 1.0]] };
    const dst = {};
    remap(src, dst, SEL);
    if (!eq(dst.contacts, [['A', 2, 'B', 2, 1.0]])) {
        throw new Error('got ' + JSON.stringify(dst.contacts)
            + ' - the second names B4, which is not in the selection');
    }
});

test('a contact list with nothing left becomes null', () => {
    const dst = {};
    remap({ contacts: [[0, 7, 1.0]] }, dst, SEL);
    if (dst.contacts !== null) throw new Error('got ' + JSON.stringify(dst.contacts));
});

test('a forced secondary structure follows its residues', () => {
    const dst = {};
    remap({ sse: { 2: 'H', 3: 'E', 7: 'C' } }, dst, SEL);
    if (!eq(dst.sse, { 1: 'H', 2: 'E' })) throw new Error('got ' + JSON.stringify(dst.sse));
});

test('per-residue colours follow their residues, and the base under them is kept', () => {
    // Only `position` inside an advanced colour is keyed by index. An
    // object-wide mode underneath it is what the overrides sit on, and a copy
    // that dropped it would recolour everything that had no override of its own.
    const src = { color: { type: 'advanced', value: { object: 'chain', position: { 2: '#f00', 7: '#0f0' } } } };
    const dst = {};
    remap(src, dst, SEL);
    if (!eq(dst.color, { type: 'advanced', value: { object: 'chain', position: { 1: '#f00' } } })) {
        throw new Error('got ' + JSON.stringify(dst.color));
    }
});

test('an object-wide colour is carried whole - it is not keyed by position', () => {
    const dst = {};
    remap({ color: { type: 'literal', value: '#123456' } }, dst, SEL);
    if (!eq(dst.color, { type: 'literal', value: '#123456' })) {
        throw new Error('got ' + JSON.stringify(dst.color));
    }
});

// ---- the wiring --------------------------------------------------------------

test('extractSelection actually carries the state across', () => {
    // The remap can be perfect and never called. This is the line that copies
    // a pose rather than a backbone.
    const at = SRC.indexOf('extractSelection() {');
    if (at < 0) throw new Error('extractSelection moved');
    const end = SRC.indexOf('\n        }\n', at);
    const body = SRC.slice(at, end);
    if (!body.includes('_remapObjectState')) {
        throw new Error('extractSelection never calls _remapObjectState - a copy'
            + ' gets the coordinates and none of the display state');
    }
    // ...onto the NEW object, not back onto the source
    if (!/_remapObjectState\(\s*object\s*,\s*this\.objectsData\[extractName\]/.test(body)) {
        throw new Error('the remap is not from the source object onto the extracted one');
    }
});

test('every display key the panel writes is one the copy knows about', () => {
    // The trap this whole file exists for: state carried field by field drops
    // whatever nobody wrote down. If the selection panel learns to store a new
    // per-object key, this fails until the remap names it too.
    const app = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
    const written = new Set();
    for (const m of app.matchAll(/\bobj\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) written.add(m[1]);
    for (const m of SRC.matchAll(/\bobject\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s/g)) written.add(m[1]);
    // Not display state: frames and geometry, bookkeeping, and the caches.
    const NOT_DISPLAY = new Set([
        'frames', 'maxExtent', 'stdDev', 'globalCenterSum', 'totalPositions',
        'visibilityState', 'ligandGroups', 'msa', 'pae', 'paeData', 'bonds',
        'name', 'colorScale', 'plddtRange', 'seqOffsets', 'chainToSequence',
        '_lastPlddtFrame', '_lastPaeFrame',
        // recomputed for the copy from its own coordinates
        'center',
        // the scatter panel's own configuration: not keyed by position, and
        // it names columns of data the copy does not carry
        'scatterConfig',
    ]);
    const at = SRC.indexOf('_remapObjectState(src, dst, selectedIndices) {');
    const remapSrc = SRC.slice(at, SRC.indexOf('\n        _remapSidechains', at));
    const missed = [...written].filter((k) => !NOT_DISPLAY.has(k) && !remapSrc.includes(`'${k}'`)
        && !remapSrc.includes(`.${k}`));
    if (missed.length) {
        throw new Error('per-object keys nobody copies: ' + missed.join(', ')
            + ' - either name them in _remapObjectState or list them as not display state');
    }
});

// ---- the MSA that comes with the copy ---------------------------------------
//
// A copy has to show the same conservation for a residue as the structure it
// was cut from, or the same residue reads two ways in two windows. The parent's
// entropy is over the sequences that pass the coverage and identity cutoffs; a
// copy that counted ALL of them read 0.2881 at residue 105 of AF-P0A8I3 where
// the parent read 0.2569.
test('a copied region keeps the parent\'s own conservation numbers', () => {
    const msa = fs.readFileSync(path.join(ROOT, 'py2Dmol/resources/viewer-msa.js'), 'utf8');
    const at = msa.indexOf('function extractMSASubset');
    if (at < 0) throw new Error('extractMSASubset is gone');
    const body = msa.slice(at, msa.indexOf('\n    function ', at + 10));
    if (!/extractedMSAData\.entropy = sliceByColumn\(originalMSAData\.entropy\)/.test(body)
        || !/extractedMSAData\.frequencies = sliceByColumn\(originalMSAData\.frequencies\)/.test(body)) {
        throw new Error('the copy no longer takes the columns the parent already '
            + 'computed - recomputing gives different numbers for the same residue, '
            + 'because coverage is measured over the copy\'s length');
    }
    // ...and ALL of them still come across, or the copy's own sliders have
    // nothing left to widen to
    if (!/sequencesOriginal: extractedSequences/.test(body)) {
        throw new Error('the copy no longer carries the sequences the filters hid');
    }
    // ...CARRYING WHAT THE FILTERS MEASURED. Slicing the parent's numbers is
    // only half of it: anything that re-runs the filters on the subset - a
    // sequence-strip rebuild after a delete, for one - measures coverage over
    // the subset's shorter length, admits a different set of sequences, and
    // moves the conservation of residues nobody touched.
    if (!/extractedSeq\.coverage = cov/.test(body) || !/extractedSeq\.identity = idt/.test(body)) {
        throw new Error('the subset does not carry each sequence\'s coverage and '
            + 'identity from the alignment it came out of');
    }
    const msaSrc = fs.readFileSync(path.join(ROOT, 'py2Dmol/resources/viewer-msa.js'), 'utf8');
    const cov = msaSrc.slice(msaSrc.indexOf('function filterByCoverage'),
        msaSrc.indexOf('function filterByIdentity'));
    if (!/typeof seq\.coverage === 'number'/.test(cov)) {
        throw new Error('filterByCoverage ignores a carried coverage, so carrying '
            + 'it changes nothing');
    }
});

process.exit(failures ? 1 : 0);
