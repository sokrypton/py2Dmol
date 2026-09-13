/* A COVALENT BOND WHOSE PROTEIN END IS A SIDE-CHAIN ATOM.
 *
 *     node tests/covalent_links.js
 *
 * Reported against 1A09 (github.com/sokrypton/py2Dmol#29): the file declares
 *
 *     covale1 covale ... A CYS 46 SG ... B PTH 2 CF ... 1.803
 *
 * and no stick was drawn. A protein residue contributes exactly ONE position -
 * its CA - so `chain:seq:SG` resolves to nothing and the bond is dropped in
 * silence, which is the same fault the `disulf` branch beside it already
 * existed for. It is not a corner: it is how a c-type cytochrome's haem is
 * attached to its cysteines (1BBH, four rows, all four lost) and how a
 * phycobilin is attached to its apoprotein (1BJP, five).
 *
 * The whole chain is real code - parseCIF -> convertParsedToFrameData -> the
 * web app's own frameObj copy -> _materialiseSidechains - because every hop of
 * it is a place this kind of thing has been dropped before. The frameObj copy
 * in particular is field by field, so a field nobody writes down is gone
 * without a word.
 *
 * 🔴 AND THE FIXTURE IS INLINE. `*.cif` is gitignored, so a test that reads
 * 1A09 off the disk is a test nobody else can run - the same reason
 * tests/cyclic_partner.js builds its ring in the file.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const L = require('./lift.js');
const ROOT = path.dirname(__dirname);

const sb = {window: {addEventListener() {}, dispatchEvent() {}},
    document: {createElement: () => ({getContext: () => null})},
    console, performance: {now: () => Date.now()}, navigator: {}, Event: function () {}};
sb.window.window = sb.window; sb.self = sb.window; vm.createContext(sb);
vm.runInContext(fs.readFileSync(ROOT + '/src/cartoon/geom.js', 'utf8'), sb, {filename: 'c'});
vm.runInContext(L.utils, sb, {filename: 'u'});

// ---------------------------------------------------------------- the fixture
//
// Six residues of protein on a zig-zag - a straight CA trace is collinear and
// gets no local frame at all, so nothing would materialise - with a cysteine in
// the middle carrying its CB and SG, and a two-atom ligand whose first atom sits
// 1.8 A off that SG. The declared bond is the one a reader can see is real.
const AT = [];
let serial = 1;
function atom(rec, name, comp, asym, seq, x, y, z, el) {
    AT.push(`${rec} ${serial++} ${el} ${name} . ${comp} ${asym} 1 ${seq} ? `
        + `${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)} 1.00 20.00 ? ${seq} ${comp} ${asym} ${name} 1`);
}
const RES = ['ALA', 'ALA', 'CYS', 'ALA', 'ALA', 'ALA'];
for (let i = 0; i < RES.length; i++) {
    const x = i * 3.8, y = (i % 2) * 1.4, z = 0;
    atom('ATOM', 'N', RES[i], 'A', i + 1, x - 1.2, y, z, 'N');
    atom('ATOM', 'CA', RES[i], 'A', i + 1, x, y, z, 'C');
    atom('ATOM', 'C', RES[i], 'A', i + 1, x + 1.2, y + 0.6, z, 'C');
    atom('ATOM', 'O', RES[i], 'A', i + 1, x + 1.2, y + 1.8, z, 'O');
    atom('ATOM', 'CB', RES[i], 'A', i + 1, x, y, z + 1.5, 'C');
    // ...and the cysteine's sulfur, which is the atom the record names
    if (RES[i] === 'CYS') atom('ATOM', 'SG', RES[i], 'A', i + 1, x, y, z + 3.3, 'S');
}
// the ligand: two atoms, the first 1.8 A beyond the SG along the same line
atom('HETATM', 'C1', 'LIG', 'B', 1, 2 * 3.8, 0, 5.1, 'C');
atom('HETATM', 'C2', 'LIG', 'B', 1, 2 * 3.8 + 1.5, 0, 5.1, 'C');

const ATOM_HDR = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id',
    'label_comp_id', 'label_asym_id', 'label_entity_id', 'label_seq_id',
    'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
    'pdbx_formal_charge', 'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id',
    'pdbx_PDB_model_num'];

const CONN_HDR = ['id', 'conn_type_id', 'ptnr1_label_asym_id', 'ptnr1_label_comp_id',
    'ptnr1_label_seq_id', 'ptnr1_label_atom_id', 'ptnr2_label_asym_id',
    'ptnr2_label_comp_id', 'ptnr2_label_seq_id', 'ptnr2_label_atom_id',
    'ptnr1_auth_asym_id', 'ptnr1_auth_seq_id', 'ptnr2_auth_asym_id', 'ptnr2_auth_seq_id',
    'pdbx_dist_value'];

// Each row is the covale exactly as the PDB writes one.
function cif(conns) {
    const out = ['data_TEST', '#', 'loop_'];
    for (const h of ATOM_HDR) out.push('_atom_site.' + h);
    out.push(...AT, '#');
    if (conns && conns.length) {
        out.push('loop_');
        for (const h of CONN_HDR) out.push('_struct_conn.' + h);
        conns.forEach((c, i) => out.push(
            `covale${i + 1} covale ${c[0]} ${c[1]} ${c[2]} ${c[3]} `
            + `${c[4]} ${c[5]} ${c[6]} ${c[7]} ${c[0]} ${c[2]} ${c[4]} ${c[6]} 1.803`));
        out.push('#');
    }
    return out.join('\n') + '\n';
}

// the reported case: a cysteine's SG bonded to a ligand atom
const SG_TO_LIG = ['A', 'CYS', 3, 'SG', 'B', 'LIG', 1, 'C1'];
// an ordinary peptide bond, which some files write as a covale too (1HVR
// writes four, 1A09 three) and which the ribbon already draws
const PEPTIDE = ['A', 'ALA', 4, 'C', 'A', 'ALA', 5, 'N'];
// a row naming a residue that is not in the file at all
const NOWHERE = ['A', 'CYS', 99, 'SG', 'B', 'LIG', 1, 'C1'];

function frameOf(text) {
    const p = sb.parseCIF(text);
    const m = p.models || p.frames;
    return sb.convertParsedToFrameData(Array.isArray(m[0]) ? m[0] : m, null,
        p.chemCompMap, false, null, p.structConn, p.chemCompBondMap);
}

let bad = 0;
const fail = (m) => { console.log('FAIL ' + m); bad++; };
const pass = (m) => console.log('PASS  ' + m);

// ------------------------------------------------------- 1. what the parse keeps
const fd = frameOf(cif([SG_TO_LIG]));
const nm = (i) => (fd.chains[i] || '?') + (fd.residue_numbers[i]) + (fd.position_names[i]);
const links = fd.covalentLinks || [];
if (links.length !== 1) {
    fail(`the SG-to-ligand covale gave ${links.length} links, not 1`
        + ` - a bond the file declares is being dropped`);
} else {
    const [ra, rb, na, nbName] = links[0];
    // the atom NAME is what makes this durable: a side-chain atom is not a
    // position until the side chain is shown
    const ok = fd.position_names[ra] === 'CYS' && na === 'SG'
        && fd.position_types[rb] === 'L' && nbName === '';
    if (!ok) fail(`the link came back as ${nm(ra)}.${na || '*'} -- ${nm(rb)}.${nbName || '*'}`
        + ` - expected the CYS side-chain atom SG against a ligand POSITION`);
    else pass(`a covale naming CYS SG survives as ${nm(ra)}.SG -- ${nm(rb)} (a position)`);
}

// ------------------------------- 2. and what it must NOT keep, which is the check
// that the side-chain-table filter is doing something
const pep = frameOf(cif([PEPTIDE])).covalentLinks || [];
if (pep.length) fail(`a peptide bond written as a covale came back as ${pep.length} link(s)`
    + ` - it would be drawn as a stick over the ribbon that already draws it`);
else pass('a peptide bond written as a covale is dropped - the ribbon draws it');

const gone = frameOf(cif([NOWHERE])).covalentLinks || [];
if (gone.length) fail(`a covale naming a residue that is not in the file gave ${gone.length} link(s)`);
else pass('a covale naming a residue that is not there resolves to nothing');

const none = frameOf(cif([])).covalentLinks;
if (none !== undefined) fail('a file with no struct_conn still carried a covalentLinks field');
else pass('a file declaring nothing carries no covalentLinks field');

// --------------------------------------- 3. the web app's field-by-field copy
// Same trap as `sidechains` and `disulfideResidues` before it: frameObj names
// every field it copies, so one nobody named is dropped in silence.
const appSrc = L.app;
const fi = appSrc.indexOf('const frameObj = {');
const fj = appSrc.indexOf('};', fi);
if (fi < 0) fail('cannot find `const frameObj = {` in src/app/ - it was renamed');
else if (!/\bcovalentLinks\b/.test(appSrc.slice(fi, fj))) {
    fail("the web app's frameObj does not name `covalentLinks`, so the renderer"
        + ' never learns the file declared any');
} else pass("the web app's frameObj carries covalentLinks");

// --------------------------------------------- 4. and it becomes a real bond
const OBJECT_STATE = new Function(
    L.between('// >>> OBJECT_STATE BEGIN', '// <<< OBJECT_STATE END')
    + '\n; return OBJECT_STATE;')();
const objectStateAbsent = new Function('OBJECT_STATE',
    L.topFunction('objectStateAbsent') + '; return objectStateAbsent;')(OBJECT_STATE);
const lift = (n) => L.method(n);
const Cls = new Function('window', 'OBJECT_STATE', 'objectStateAbsent',
    'return class V {' + lift('_materialiseSidechains')
    + L.staticGet('ELEMENT_COLORS') + lift('_segmentElementColor')
    + lift('_segmentElementHalves') + lift('elementAt') + lift('_elementOwnerOf')
    + lift('shownSidechainSet') + lift('mergedObjectSet') + '}')(
    sb.window, OBJECT_STATE, objectStateAbsent);

// THE OBJECT'S LIST, NOT THE FRAME'S. src/core/mol.js hoists it off frame 0
// onto the object, because what a file declares about the molecule is the same
// in every frame; _materialiseSidechains reads it there.
function materialise(frame, shownOwners, linkList) {
    const v = new Cls();
    v.currentObjectName = 'o';
    v.multiState = {enabled: false};
    v.positionTypes = frame.position_types || [];
    v._invalidateSegmentCache = function () { this.cachedSegmentIndices = null; };
    v.objectsData = {o: {sidechains: new Set(shownOwners),
        covalentLinks: linkList === undefined ? (frame.covalentLinks || null) : linkList}};
    return {out: v._materialiseSidechains(frame), v};
}

// which position is the cysteine, and which is the ligand's C1
let cysPos = -1, ligPos = -1;
for (let i = 0; i < fd.coords.length; i++) {
    if (fd.position_names[i] === 'CYS') cysPos = i;
    if (fd.position_types[i] === 'L' && ligPos < 0) ligPos = i;
}
const sc = fd.sidechains;
// the frame as the renderer receives it, carrying the coordinates as arrays
const frame = {coords: fd.coords, chains: fd.chains, position_types: fd.position_types,
    position_names: fd.position_names, residue_numbers: fd.residue_numbers,
    position_elements: fd.position_elements, sidechains: sc,
    covalentLinks: fd.covalentLinks, bonds: fd.bonds};

const bondsHave = (o, a, b) => (o.bonds || []).some(
    (p) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));

// the SG's appended index: the atom named SG whose owner is the cysteine
function sgOf(o) {
    const n0 = fd.coords.length;
    for (let i = n0; i < o.coords.length; i++) {
        if ((o.position_elements || [])[i] === 'S') return i;
    }
    return -1;
}

const shown = materialise(frame, [cysPos]);
const sg = sgOf(shown.out);
if (sg < 0) {
    fail('the cysteine side chain did not materialise an S at all - the fixture is wrong,'
        + ' so nothing below means anything');
} else if (!bondsHave(shown.out, sg, ligPos)) {
    fail(`the declared bond CYS SG -- ligand C1 is not in the bond list after`
        + ` materialising (SG became position ${sg}, the ligand atom is ${ligPos})`);
} else pass(`the declared bond becomes a real bond once the side chain is shown`);

// ...AND A PARTNER THAT IS NOT SHOWN IS NOT HALF A BOND. The same rule the
// disulfides get for free: an end naming a side-chain atom exists only while
// that side chain does, so with the cysteine off there is nothing to bond to -
// and nothing may throw on the way to finding that out.
const hidden = materialise(frame, []);
if ((hidden.out.bonds || []).length !== (fd.bonds || []).length) {
    fail('a link was drawn while the side chain carrying one of its ends was hidden');
} else pass('with the side chain hidden the link is not drawn, and nothing throws');

// AND A LINK CANNOT REACH AN ATOM THAT IS NOT THERE. Indices are reissued on
// every materialisation, so a list naming a row that no longer exists must
// resolve to nothing rather than to whatever moved into the slot.
//
// 🔴 AND THE CONTROL IS THE SAME SIDE CHAIN WITH NO LINKS, NOT THE BARE FRAME.
// Materialising a cysteine appends its own CA-CB and CB-SG bonds, so comparing
// against fd.bonds counts those as the link and this leg failed against
// correct code. The pair that differs in ONE thing is the link list.
const noLinks = materialise(frame, [cysPos], null);
const stale = materialise(frame, [cysPos], [[cysPos, ligPos, 'ZZ', '']]);
const nNo = (noLinks.out.bonds || []).length;
if ((stale.out.bonds || []).length !== nNo) {
    fail('a link naming an atom the residue does not have was still drawn');
} else if ((shown.out.bonds || []).length !== nNo + 1) {
    fail(`the link arm has ${(shown.out.bonds || []).length} bonds and the no-link arm`
        + ` ${nNo} - the pair must differ by exactly the one declared link, or`
        + ' neither of these legs is measuring it');
} else pass('a link naming an atom that is not there draws nothing, and a real one'
    + ' adds exactly one bond');

// ----------------------------------- 5. and the residues open with it shown
//
// The resolution above needs the atom to EXIST, and a side-chain atom exists
// only while its side chain is shown - so on a structure nobody has clicked,
// a declared link is a bond nothing can draw and the ligand opens attached to
// nothing. That is the picture the report is of. The residues at the ends of a
// declared link therefore open with their side chains out.
const Seed = new Function('return class V {' + lift('_seedCovalentSidechains') + '}')();
const seedOn = (obj) => { const v = new Seed(); return v._seedCovalentSidechains(obj); };

const o1 = {covalentLinks: fd.covalentLinks};
if (!seedOn(o1)) fail('a declared link did not switch its residue on at load');
else if (!(o1.sidechains instanceof Set) || !o1.sidechains.has(cysPos)) {
    fail(`the cysteine at the end of the declared link (position ${cysPos}) did not`
        + ' open with its side chain shown, so the link cannot be drawn');
} else pass('the residue at a declared link opens with its side chain shown');

// ...AND ONLY THE END THAT HAS A SIDE CHAIN. A ligand atom is a position
// already; adding its residue to the set would ask for side chains on a ligand.
if (o1.sidechains && o1.sidechains.has(ligPos)) {
    fail('the ligand end of the link was added to the side-chain set');
} else pass('the ligand end is left alone - it is a position already');

// 🔴 ONCE, AND NOT A POLICY. A reader who turns one of these off has said
// something; a default re-applied on the next frame would override them.
o1.sidechains = null;
if (seedOn(o1) || o1.sidechains) {
    fail('the seeding ran a second time on the same object - a side chain the'
        + ' reader switched off would come back');
} else pass('the seeding runs once per object, so switching one off sticks');

// and a structure that declares nothing is untouched
const o2 = {};
if (seedOn(o2) || o2.sidechains) fail('a structure with no declared links had side chains switched on');
else pass('a structure declaring no links opens exactly as it did');

console.log('covalent links: ' + (bad ? `FAILED (${bad})` : 'ok'));
process.exit(bad ? 1 : 0);
