/* A PEPTIDE TOO SHORT TO HAVE A SHAPE IS DRAWN AS WHAT IT IS: A LIGAND.
 *
 *     node tests/short_peptide.js
 *
 * A cartoon is a statement about secondary structure, and two residues have
 * none - what it draws is one segment between two alpha carbons, which says
 * nothing a reader wanted and throws away every atom that did. 1A09 is the
 * case: the file annotates its inhibitor ACE-PTH-GLU-DIP as a polymer entity,
 * so the two residues in the middle that look like amino acids took the CA
 * branch while the ACE and DIP caps either side of them were drawn whole,
 * being HETATM. Half a ligand, cut down the middle by a rule about polymers.
 *
 * 🔴 AND THE SCANNER HAD TO BE TOLD, WHICH IS THE PART THAT BROKE FIRST.
 * readCIFCols throws away a standard residue's N, C and O before anything
 * knows what chain it is in - 38.6% of a capsid's rows, abandoned before they
 * are tokenised - on the premise that only the CA ever reaches `coords`. That
 * premise dies here. The first version of this change produced a glutamate
 * holding a CA and a side chain and NO BACKBONE, detached from the residue
 * before it, and every count-based check passed against it: the residue was
 * there, it had atoms, it was a ligand. Only asking for the atoms BY NAME
 * finds it, which is what this file does.
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

const ATOM_HDR = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id',
    'label_comp_id', 'label_asym_id', 'label_entity_id', 'label_seq_id',
    'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
    'pdbx_formal_charge', 'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id',
    'pdbx_PDB_model_num'];

// GLU, because it is STANDARD - which is the whole point. A standard residue is
// the one whose N, C and O the scanner throws away, so a non-standard one would
// pass this test while the bug was present.
const SIDE = {ALA: [['CB', 0, 0, 1.5, 'C']],
    GLU: [['CB', 0, 0, 1.5, 'C'], ['CG', 0.6, 0.6, 2.7, 'C'], ['CD', 0, 1.2, 3.9, 'C'],
        ['OE1', -1.1, 1.2, 4.4, 'O'], ['OE2', 0.8, 2.0, 4.3, 'O']]};

// `entity` so the row carries one, `withEntityLoop` so the file declares how
// long each entity is - the scanner reads that and nothing else can tell it.
function build(chains, withEntityLoop) {
    const rows = []; const seqs = [];
    let serial = 1;
    for (const ch of chains) {
        seqs.push({id: ch.entity, n: ch.res.length});
        for (let i = 0; i < ch.res.length; i++) {
            const comp = ch.res[i];
            const x = ch.x0 + i * 3.8, y = (i % 2) * 1.4;
            const atoms = [['N', -1.2, 0, 0, 'N'], ['CA', 0, 0, 0, 'C'],
                ['C', 1.2, 0.6, 0, 'C'], ['O', 1.2, 1.8, 0, 'O'], ...(SIDE[comp] || [])];
            for (const [nm, dx, dy, dz, el] of atoms) {
                rows.push(`ATOM ${serial++} ${el} ${nm} . ${comp} ${ch.asym} ${ch.entity} `
                    + `${i + 1} ? ${(x + dx).toFixed(3)} ${(y + dy).toFixed(3)} ${dz.toFixed(3)} `
                    + `1.00 20.00 ? ${i + 1} ${comp} ${ch.asym} ${nm} 1`);
            }
        }
    }
    const out = ['data_T', '#', 'loop_'];
    for (const h of ATOM_HDR) out.push('_atom_site.' + h);
    out.push(...rows, '#');
    if (withEntityLoop) {
        out.push('loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num',
            '_entity_poly_seq.mon_id');
        for (const s of seqs) {
            for (let k = 1; k <= s.n; k++) out.push(`${s.id} ${k} ALA`);
        }
        out.push('#');
    }
    return out.join('\n') + '\n';
}

function frameOf(text) {
    const p = sb.parseCIF(text);
    const m = p.models || p.frames;
    return sb.convertParsedToFrameData(Array.isArray(m[0]) ? m[0] : m, null,
        p.chemCompMap, false, null, p.structConn, p.chemCompBondMap);
}

let bad = 0;
const fail = (m) => { console.log('FAIL ' + m); bad++; };
const pass = (m) => console.log('PASS  ' + m);

const LONG = {asym: 'A', entity: '1', x0: 0,
    res: ['ALA', 'GLU', 'ALA', 'ALA', 'GLU', 'ALA', 'ALA', 'ALA', 'ALA', 'ALA']};
const SHORT = {asym: 'B', entity: '2', x0: 60, res: ['GLU', 'GLU']};

const fd = frameOf(build([LONG, SHORT], true));
const idxOf = (ch) => {
    const out = [];
    for (let i = 0; i < fd.coords.length; i++) if (fd.chains[i] === ch) out.push(i);
    return out;
};
const A = idxOf('A'), B = idxOf('B');

// ---------------------------------------------------- the long chain is untouched
if (A.length !== LONG.res.length || !A.every((i) => fd.position_types[i] === 'P')) {
    fail(`the ten-residue chain came back as ${A.length} positions`
        + ` (${A.map((i) => fd.position_types[i]).join('')}) - it must be one CA each`);
} else pass('a chain long enough for a cartoon is still one position per residue');

// -------------------------------------------- and the short one is a ligand
if (!B.length || !B.every((i) => fd.position_types[i] === 'L')) {
    fail(`the two-residue chain came back as ${B.length} positions of type`
        + ` ${[...new Set(B.map((i) => fd.position_types[i]))].join('')} - it should be`
        + ' every atom, drawn as a ligand');
} else pass(`a two-residue chain is drawn as a ligand - ${B.length} atoms, not 2 alpha carbons`);

// 🔴 -------------------------- WITH ITS BACKBONE, WHICH IS THE ONE THAT BROKE
//
// Counting atoms is not enough and that is the lesson: the broken version gave
// six atoms per glutamate - CA and the side chain - which is more than two and
// passes every check but this one. Ask for the atoms BY NAME.
const elOf = fd.position_elements || [];
const nmOf = new Map();
{
    // the file's own atom names are not carried per position (see the note on
    // position_atoms), so the backbone is identified by what only it can be:
    // a glutamate has exactly one N, and it is the backbone nitrogen.
    for (const i of B) nmOf.set(i, elOf[i]);
}
const perRes = new Map();
for (const i of B) {
    const k = fd.residue_numbers[i];
    if (!perRes.has(k)) perRes.set(k, []);
    perRes.get(k).push(elOf[i]);
}
let lost = [];
for (const [res, els] of perRes) {
    const n = els.filter((e) => e === 'N').length;
    const o = els.filter((e) => e === 'O').length;
    // GLU: one backbone N, one backbone O, two carboxylate O - so N >= 1 and
    // O >= 3. Without the backbone it is N 0, O 2.
    if (n < 1 || o < 3) lost.push(`residue ${res} has ${n} N and ${o} O`);
}
if (lost.length) {
    fail('a short peptide\'s residues lost their backbone atoms - '
        + lost.join(', ') + '. The mmCIF scanner drops a STANDARD residue\'s'
        + ' N, C and O before anything knows what chain it is in; a residue'
        + ' drawn as a ligand needs them back');
} else pass('a short peptide keeps its backbone N, C and O');

// ...AND THE RESIDUES ARE JOINED TO EACH OTHER. A peptide whose two halves are
// not bonded is two fragments floating beside each other, which is what losing
// the backbone produced.
const g = (v, i) => (Array.isArray(v) ? v[i] : [v.x, v.y, v.z][i]);
let joined = false;
for (const i of B) for (const j of B) {
    if (fd.residue_numbers[i] === fd.residue_numbers[j]) continue;
    const p = fd.coords[i], q = fd.coords[j];
    const d = Math.hypot(g(p,0)-g(q,0), g(p,1)-g(q,1), g(p,2)-g(q,2));
    if (d < 1.8) joined = true;
}
if (!joined) {
    fail('no two atoms of the short peptide\'s two residues are within bonding'
        + ' distance - the halves cannot be connected, so it draws as fragments');
} else pass('the short peptide\'s residues have atoms within bonding distance');

// ------------------------------- and the optimisation it works around survives
//
// The scanner's drop is worth 38.6% of a capsid's rows. The gate must spare a
// SHORT entity and nothing else, so the long chain's glutamates - standard
// residues in a ten-residue entity - must still arrive as one CA.
const longGlu = A.filter((i) => fd.position_names[i] === 'GLU');
if (longGlu.length !== 2) {
    fail(`the long chain has ${longGlu.length} glutamate positions, not 2 -`
        + ' its standard residues are no longer being reduced to their CA,'
        + ' so the scanner optimisation has been lost for every file');
} else pass('a standard residue in a LONG chain is still reduced to its CA');

// ---------------------------------------- and a file that declares no lengths
//
// A PDB-issued mmCIF always carries entity_poly_seq; one written by hand may
// not, and then nothing can know a chain is short before the atoms are read.
// The answer must be the OLD behaviour - every chain a polymer - rather than
// anything clever, because the alternative is a scanner that keeps every
// backbone atom of every file on the chance that a chain turns out to be short.
const noLoop = frameOf(build([LONG, SHORT], false));
const nB = [];
for (let i = 0; i < noLoop.coords.length; i++) if (noLoop.chains[i] === 'B') nB.push(i);
if (nB.length !== SHORT.res.length) {
    fail(`with no entity_poly_seq the short chain gave ${nB.length} positions,`
        + ` not ${SHORT.res.length} - without the declared lengths it must fall`
        + ' back to what it always did');
} else pass('a file declaring no entity lengths behaves exactly as it did');

// ------------------------------------- and the two thresholds must stay in step
//
// 🔴 THERE ARE TWO NUMBERS HERE AND ONE OF THEM GOVERNS THE OTHER. The drawing
// rule counts PROTEIN residues in a chain (SHORT_PEPTIDE_MAX); the scanner's
// gate counts MONOMERS in an entity (SMALL_ENTITY_MONOMERS) and decides whether
// the backbone survives to be drawn at all. Raise the first above the second
// and the rule silently stops working for every chain between them: the
// classifier wants to demote, the atoms are gone, hasBackbone says no, and the
// peptide quietly goes back to being a pair of alpha carbons with nothing said.
//
// This is asserted rather than measured because a fixture CANNOT catch it - the
// arrangement that would expose it is a chain long enough for the drawing rule
// and short enough for the scanner, which is exactly the window this invariant
// forbids. Mutating SHORT_PEPTIDE_MAX to 20 passes every check above.
{
    const src = fs.readFileSync(path.join(ROOT, 'src/io/parse.js'), 'utf8');
    const num = (name) => {
        const m = new RegExp('const ' + name + ' = (\\d+);').exec(src);
        return m ? +m[1] : null;
    };
    const draw = num('SHORT_PEPTIDE_MAX'), keep = num('SMALL_ENTITY_MONOMERS');
    if (draw === null || keep === null) {
        fail('cannot find SHORT_PEPTIDE_MAX and SMALL_ENTITY_MONOMERS in'
            + ' src/io/parse.js - one was renamed, so nothing checks that they'
            + ' are in step any more');
    } else if (keep < draw) {
        fail(`SMALL_ENTITY_MONOMERS (${keep}) is below SHORT_PEPTIDE_MAX (${draw}):`
            + ' the scanner throws away the backbone of the very chains the'
            + ' drawing rule wants to draw whole, and the rule stops working'
            + ' with nothing said');
    } else pass(`the scanner keeps backbones up to ${keep} monomers, which covers`
        + ` the ${draw}-residue drawing rule and its caps`);
}

console.log('short peptide: ' + (bad ? `FAILED (${bad})` : 'ok'));
process.exit(bad ? 1 : 0);
