// A PAIRED MSA: ONE ALIGNMENT, SEVERAL CHAINS.
//
// A multimer alignment is the chains' queries concatenated, and row s means one
// organism ACROSS all of them. Everything here is about that statement
// surviving: the app has to RECOGNISE a concatenated query (it matches no
// single chain, so the per-chain matcher dropped it), the panel has to score a
// row over the blocks it occupies (on the full width every unpaired row of a
// two-chain alignment scores under the coverage filter's own default and the
// whole unpaired block is deleted before it is drawn), and a column has to know
// which chain it belongs to (or the picture cannot talk to the structure).
//
// Runs in node: msa.js is an IIFE that publishes window.MSA and touches no DOM
// at load, and the app's matcher is lifted as text.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('./lift.js');

let failures = 0;
function check(name, condition, detail) {
    if (condition) { console.log(`ok   ${name}`); return; }
    failures++;
    console.log(`FAIL ${name}${detail !== undefined ? ` - ${detail}` : ''}`);
}

// --- the panel, evaluated ---------------------------------------------------
const sandbox = {
    window: {}, console,
    // Enough DOM to be absent. Every view builder starts by looking for its
    // container and gives up when there is none, so the data pipeline runs and
    // the drawing does not - which is the half a node test can speak for.
    document: {
        createElement: () => ({ getContext: () => null, style: {}, classList: { add() {}, remove() {} } }),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
    }
};
vm.createContext(sandbox);
// The panel reads the residue table off `window`, where src/io/parse.js puts
// it. Lifted rather than written out here - a second table would be a second
// answer to what a three-letter code means.
const tableAt = L.utils.indexOf('\nconst RESIDUE_TO_AA = {');
const tableEnd = L.matchBrace(L.utils, L.utils.indexOf('{', tableAt));
vm.runInContext('window.RESIDUE_TO_AA = '
    + L.utils.slice(L.utils.indexOf('{', tableAt), tableEnd + 1) + ';', sandbox);
vm.runInContext(fs.readFileSync(path.join(L.ROOT, 'src/panels/msa.js'), 'utf8'),
    sandbox, { filename: 'msa.js' });
const MSA = sandbox.window.MSA;
check('msa.js publishes the paired verbs',
    !!(MSA && MSA.annotateChainBlocks && MSA.computeColumnMap && MSA.chainsOfBlocks));

// --- the app's matcher, lifted ----------------------------------------------
// Text, not a copy: this is the function that decides a query is a
// concatenation, and a reimplementation here would be a second opinion.
function appFunction(name) {
    const at = L.app.indexOf(`\nfunction ${name}(`);
    if (at < 0) throw new Error(`app function not found: ${name}`);
    const end = L.matchBrace(L.app, L.app.indexOf('{', at));
    return L.app.slice(at, end + 1);
}
const appSandbox = { console };
vm.createContext(appSandbox);
vm.runInContext(appFunction('splitQueryIntoChainBlocks'), appSandbox);
const splitQueryIntoChainBlocks = appSandbox.splitQueryIntoChainBlocks;

// --- fixtures ---------------------------------------------------------------
const CHAIN_A = 'ACDEFGHIKL';   // 10
const CHAIN_B = 'MNPQRST';      // 7
const chainSequences = { A: CHAIN_A, B: CHAIN_B };

// ============================================================================
// 1. RECOGNISING THE CONCATENATION
// ============================================================================
const blocks = splitQueryIntoChainBlocks(CHAIN_A + CHAIN_B, chainSequences);
check('a concatenated query splits into one block per chain', blocks && blocks.length === 2,
    blocks && blocks.length);
check('the blocks are the chains, in order',
    blocks && blocks[0].chain === 'A' && blocks[1].chain === 'B');
check('the boundary is where the second chain starts',
    blocks && blocks[0].end === 10 && blocks[1].start === 10, blocks && blocks[1].start);
check('the blocks cover every column',
    blocks && blocks[0].start === 0 && blocks[1].end === 17, blocks && blocks[1].end);

// A HOMODIMER IS THE CASE THE CURSOR EXISTS FOR: both chains are the same
// string, and a search from zero would anchor them both at zero.
const homo = splitQueryIntoChainBlocks(CHAIN_A + CHAIN_A, { A: CHAIN_A, B: CHAIN_A });
check('a homodimer anchors its second copy past its first',
    homo && homo[1].seqStart === 10, homo && homo[1].seqStart);

check('one chain is not a pairing',
    splitQueryIntoChainBlocks(CHAIN_A, { A: CHAIN_A }) === null);
check('a query that is not the concatenation is refused',
    splitQueryIntoChainBlocks('WWWWWWWWWW', chainSequences) === null);

// A structure missing its first residues still anchors, inside the block.
const trimmed = splitQueryIntoChainBlocks(CHAIN_A + CHAIN_B, { A: CHAIN_A.slice(2), B: CHAIN_B });
check('an unmodelled terminus anchors inside its block, not at the boundary',
    trimmed && trimmed[0].seqStart === 2 && trimmed[0].start === 0,
    trimmed && `${trimmed[0].seqStart}/${trimmed[0].start}`);

// ============================================================================
// 2. SCORING A ROW OVER ITS OWN BLOCKS
// ============================================================================
// Two paired rows, one homolog of A alone, one of B alone. The unpaired pair is
// what the whole rule is about.
const a3m = [
    '>query', CHAIN_A + CHAIN_B,
    '>paired_1', 'ACDEFGHIKA' + 'MNPQRSA',
    '>paired_2', 'ACDEFGHIAA' + 'MNPQRAA',
    '>onlyA', 'ACDEFGHIKL' + '-------',
    '>onlyB', '----------' + 'MNPQRST',
    ''
].join('\n');

function pairedFixture() {
    const data = MSA.parseA3M(a3m);
    data.chainBlocks = splitQueryIntoChainBlocks(data.querySequence, chainSequences);
    MSA.annotateChainBlocks(data);
    return data;
}
const paired = pairedFixture();
const byName = {};
for (const seq of paired.sequencesOriginal) byName[seq.name] = seq;

check('a row spanning both chains is paired', byName.paired_1.isPaired === true);
check('a row in one chain is not', byName.onlyA.isPaired === false && byName.onlyB.isPaired === false);
check('an unpaired row is scored over its own chain, not the whole width',
    byName.onlyA.coverage === 1 && byName.onlyB.coverage === 1,
    `${byName.onlyA.coverage} / ${byName.onlyB.coverage}`);

// THE MEASUREMENT THAT MAKES THAT WORTH HAVING. Scored on the full width, chain
// B's 7 columns of 17 are 0.41 - under the coverage filter's own default of
// 0.5 - so the unpaired block is deleted before anything draws it.
const naiveB = byName.onlyB.sequence.replace(/-/g, '').length / paired.queryLength;
check('scored on the full width that row would fall under the default cutoff',
    naiveB < 0.5, naiveB.toFixed(3));

const kept = MSA.applyFiltersToMSA(paired, 0.5, 0.15);
const keptNames = kept.sequences.map(s => s.name);
check('the unpaired rows survive the default coverage filter',
    keptNames.includes('onlyA') && keptNames.includes('onlyB'), keptNames.join(','));
check('the filtered copy remembers it is paired',
    !!(kept.chainBlocks && kept.chainBlocks.length === 2));

// ...and with the blocks taken away, they do not. This is the mutation the
// check above is written against, run rather than imagined.
const unaware = MSA.parseA3M(a3m);
const keptUnaware = MSA.applyFiltersToMSA(unaware, 0.5, 0.15).sequences.map(s => s.name);
check('...and without blocks the same filter deletes them',
    !keptUnaware.includes('onlyB'), keptUnaware.join(','));

// ============================================================================
// 3. THE PAIRED ROWS STAY ON TOP
// ============================================================================
// Through setMSAData, which is the real pipeline: computeFilteredMSA with the
// sort switched on, which is where the ordering rule lives and where the
// filtered copy is rebuilt field by field. applyFiltersToMSA above does not
// sort, so an ordering assertion made through it passes whatever the
// comparator does - measured, by mutating the comparator away and watching it
// survive.
//
// 🔴 AND THE UNPAIRED ROWS HERE ARE PERFECT MATCHES OVER THEIR OWN CHAIN, so
// once they are scored over their own blocks - which is the previous section's
// whole point - an identity sort alone puts them ABOVE the paired ones. The
// two rules pull in opposite directions, and that is exactly why pairing has
// to be the first key.
MSA.setMSAData(pairedFixture(), 'A');
const displayed = MSA.getMSAData();
check('the pipeline keeps the blocks on the filtered copy',
    !!(displayed && displayed.chainBlocks && displayed.chainBlocks.length === 2));
const sorted = displayed.sequences.map(s => s.name);
const firstUnpaired = Math.min(sorted.indexOf('onlyA'), sorted.indexOf('onlyB'));
const lastPaired = Math.max(sorted.indexOf('paired_1'), sorted.indexOf('paired_2'));
check('paired rows sort above unpaired ones', lastPaired < firstUnpaired, sorted.join(','));
check('...and identity still orders within the group',
    sorted.indexOf('paired_1') < sorted.indexOf('paired_2'), sorted.join(','));

// ============================================================================
// 4. A COLUMN KNOWS WHICH CHAIN IT IS
// ============================================================================
// A frame in the shape the renderer keeps: one position per residue, chains
// side by side, residue numbers restarting per chain.
const frame = { chains: [], position_types: [], residue_numbers: [], position_names: [] };
const THREE = {
    A: 'ALA', C: 'CYS', D: 'ASP', E: 'GLU', F: 'PHE', G: 'GLY', H: 'HIS', I: 'ILE',
    K: 'LYS', L: 'LEU', M: 'MET', N: 'ASN', P: 'PRO', Q: 'GLN', R: 'ARG', S: 'SER',
    T: 'THR'
};
for (const [chain, sequence] of Object.entries(chainSequences)) {
    sequence.split('').forEach((aa, i) => {
        frame.chains.push(chain);
        frame.position_types.push('P');
        frame.residue_numbers.push(i + 1);
        frame.position_names.push(THREE[aa]);
    });
}

const columnMap = MSA.computeColumnMap(paired, frame);
check('every column of a paired alignment resolves', columnMap
    && columnMap.every(entry => entry !== null), columnMap && columnMap.filter(e => !e).length);
check('the first block is chain A', columnMap && columnMap[0].chain === 'A');
check('the second block is chain B', columnMap && columnMap[10].chain === 'B');
check('a chain B column points at a chain B position',
    columnMap && frame.chains[columnMap[10].position] === 'B');
check('...and at that chain\'s own residue number, not the running one',
    columnMap && columnMap[10].residueNumber === 1, columnMap && columnMap[10].residueNumber);
check('the last column is the last residue of the last chain',
    columnMap && columnMap[16].chain === 'B' && columnMap[16].residueNumber === 7);

// An alignment that is not paired has no column map to give: the per-chain walk
// is still the answer there, and answering anyway would take it over.
check('an unpaired alignment yields no column map',
    MSA.computeColumnMap(unaware, frame) === null);

// ============================================================================
// 5. THE ALPHAFOLD 3 SERVER'S FOUR FILES AS ONE ALIGNMENT
// ============================================================================
// A download carries `<job>_paired_msa_chains_a.a3m` and `..._unpaired_...`,
// one pair per chain - and the two PAIRED files are not row-aligned: they are
// the raw all-seqs searches, different depths, different species order. The
// pairing is in the headers, and it is recovered the way AlphaFold's own
// featuriser recovers it.

const af3ServerMSARole = (() => {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(appFunction('af3ServerMSARole'), sandbox);
    return sandbox.af3ServerMSARole;
})();

check('a paired server file is recognised',
    af3ServerMSARole('fold_2026_01_01_00_00_paired_msa_chains_a.a3m') === 'paired');
check('...and an unpaired one',
    af3ServerMSARole('fold_2026_01_01_00_00_unpaired_msa_chains_b.a3m') === 'unpaired');
check('an ordinary alignment is neither',
    af3ServerMSARole('my_protein.a3m') === null);

// THE SPECIES IS THE UNIPROT ENTRY NAME, WHICH IS WHAT ALPHAFOLD PAIRS ON.
// `OX=` is the numeric taxon and splits strains apart - three ids for one
// Helicobacter pylori on the real file - so pairing on it pairs less deeply
// than the model did and shows an alignment nothing was folded from.
check('the species is the mnemonic, not the taxon id',
    MSA.speciesOfRow('sp|P56422|MOAE_HELPY/2-145 [subseq from] x OS=Helicobacter pylori OX=85962')
    === 'HELPY');
check('...and a header with no entry name still answers, from the taxon',
    MSA.speciesOfRow('UniRef90_P56422/2-145 n=683 Tax=Helicobacter TaxID=210') === '210');
check('a header with neither has no species', MSA.speciesOfRow('query') === null);

const CH1 = 'ACDEFGHIKL';        // 10
const CH2 = 'MNPQRSTVWY';        // 10
const a3mOf = (query, rows) => ['>query', query]
    .concat(rows.flatMap(([name, seq]) => ['>' + name, seq])).join('\n') + '\n';

// Chain 1: two HELPY rows, one HELPX. Chain 2: one HELPY, one FUNHE.
// So HELPY pairs (one row deep, the smaller side), HELPX and FUNHE do not.
const pairedOne = MSA.parseA3M(a3mOf(CH1, [
    ['sp|P00001|AAA_HELPY x', 'ACDEFGHIKA'],
    ['sp|P00002|BBB_HELPX x', 'ACDEFGHIAA'],
    ['sp|P00003|CCC_HELPY x', 'ACDEFGHAAA'],
]));
const pairedTwo = MSA.parseA3M(a3mOf(CH2, [
    ['sp|P00004|DDD_HELPY x', 'MNPQRSTVWA'],
    ['sp|P00005|EEE_FUNHE x', 'MNPQRSTVAA'],
]));
const unpairedOne = MSA.parseA3M(a3mOf(CH1, [
    ['UniRef90_Z1 n=1', 'ACDEFGHIKK'],
    // ...and a row the paired file also has, which must not appear twice.
    ['UniRef90_Z2 n=1', 'ACDEFGHIKA'],
]));
const unpairedTwo = MSA.parseA3M(a3mOf(CH2, [['UniRef90_Z3 n=1', 'MNPQRSTVWW']]));

const af3 = MSA.combinePairedAlignments([
    { chain: 'A', paired: pairedOne, unpaired: unpairedOne },
    { chain: 'B', paired: pairedTwo, unpaired: unpairedTwo },
]);
check('the four files become one alignment over both chains',
    !!af3 && af3.queryLength === 20, af3 && af3.queryLength);
check('...with a block per chain', af3.chainBlocks.length === 2
    && af3.chainBlocks[1].start === 10);
check('every row is the full width',
    af3.sequences.every((row) => row.sequence.length === 20));

const af3Paired = af3.sequences.filter((row) => row.isPaired && !isQuery(row.name));
function isQuery(name) { return name === 'query'; }
check('the shared species pairs', af3Paired.length === 1,
    af3Paired.map((r) => r.name).join(','));
check('...as the two rows of that species, side by side',
    af3Paired[0] && af3Paired[0].sequence === 'ACDEFGHIKA' + 'MNPQRSTVWA',
    af3Paired[0] && af3Paired[0].sequence);

// A SPECIES IN ONE CHAIN ONLY IS NOT A PAIR, and it is not dropped either -
// it was found by a real search, so it belongs in the unpaired block.
const names = af3.sequences.map((row) => row.name);
check('a species with no partner falls to the unpaired block',
    names.some((n) => n.includes('HELPX')) && names.some((n) => n.includes('FUNHE')),
    names.join(','));

// AlphaFold's `deduplicate_unpaired_sequences`: the two files are two searches
// and they overlap.
const chainAUnpaired = af3.sequences.filter(
    (row) => !row.isPaired && row.sequence.startsWith('ACDEFGHIK'));
check('a row in both the paired and the unpaired file appears once',
    chainAUnpaired.filter((row) => row.sequence.startsWith('ACDEFGHIKA')).length === 0,
    'the paired copy is the one that counts');

// A HOMO-OLIGOMER HAS NO PAIR SEARCH - there is nothing to pair - and its
// copies are not separate chains: one search speaks for every copy, which is
// what AlphaFold's own _merge_homomers_dense_msa says.
const homoDense = MSA.combinePairedAlignments([
    { chain: 'A', paired: null, unpaired: unpairedOne },
    { chain: 'B', paired: null, unpaired: unpairedOne },
]);
check('copies of one chain share their alignment densely',
    homoDense && homoDense.sequences.every((row) => row.isPaired),
    homoDense && homoDense.sequences.map((r) => r.sequence).join(' '));
check('...and each row is drawn once, not once per copy',
    homoDense && homoDense.sequences.length === 3, homoDense && homoDense.sequences.length);

check('one chain is not a complex', MSA.combinePairedAlignments(
    [{ chain: 'A', paired: pairedOne, unpaired: unpairedOne }]) === null);

// ============================================================================
// 6. THREE CHAINS, AND A ROW THAT PAIRS IN TWO OF THEM
// ============================================================================
// 🔴 THE CASE THE BLOCK-AWARE SCORING EXISTS FOR, once the paired view holds
// only paired rows. On two chains every surviving row spans both, so the mask
// is the whole width and the rule does nothing. On THREE, AlphaFold pairs a
// species present in two chains and pads the third with gaps - and that row
// covers 2/3 of the columns, under the coverage filter's 0.75 default. Scored
// over the blocks it occupies it is a complete hit in both, which is what it
// is.
const C1 = 'ACDEFGHIKL', C2 = 'MNPQRSTVWY', C3 = 'GGGAAAWWWY';
const three = MSA.combinePairedAlignments([
    { chain: 'A', unpaired: null, paired: MSA.parseA3M(a3mOf(C1, [
        ['sp|P00001|A_HELPY x', 'ACDEFGHIKA'],
        ['sp|P00002|B_HELPX x', 'ACDEFGHIAA']])) },
    { chain: 'B', unpaired: null, paired: MSA.parseA3M(a3mOf(C2, [
        ['sp|P00003|C_HELPY x', 'MNPQRSTVWA'],
        ['sp|P00004|D_HELPX x', 'MNPQRSTVAA']])) },
    // HELPX is in the first two chains only.
    { chain: 'C', unpaired: null, paired: MSA.parseA3M(a3mOf(C3, [
        ['sp|P00005|E_HELPY x', 'GGGAAAWWWA']])) },
]);
const threeOnly = MSA.pairedRowsOnly(three);
const partial = threeOnly.sequences.find((row) => /HELPX/.test(row.name || ''));

check('a species in two of three chains still pairs', !!partial,
    threeOnly.sequences.map((r) => r.name).join(','));
check('...with the chain it is missing from left as gaps',
    partial && partial.pairedBlocks === 2 && /^-+$/.test(partial.sequence.slice(20)),
    partial && partial.sequence);

const naiveCoverage = [...partial.sequence].filter((c) => c !== '-').length
    / partial.sequence.length;
check('measured over the whole width it would fall under the 0.75 default',
    naiveCoverage < 0.75, naiveCoverage.toFixed(2));
check('measured over the blocks it occupies it is complete',
    partial.coverage === 1, partial.coverage);
check('...so the default filter keeps it',
    MSA.applyFiltersToMSA(threeOnly, 0.75, 0.15).sequences
        .some((row) => /HELPX/.test(row.name || '')));
check('and its identity is not diluted by the chain it has nothing in',
    partial.identity === 0.8, partial.identity);

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
