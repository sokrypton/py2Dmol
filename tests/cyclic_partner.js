/* A CYCLIC PEPTIDE BOUND TO SOMETHING ELSE MUST NOT LOSE ITS STRANDS.
 *
 *   node tests/cyclic_partner.js
 *
 * assignSecondary handles a head-to-tail closure by re-assigning the ring
 * under several rotations and keeping, for each residue, the pass in which
 * the artificial break was furthest away. Those extra passes run on the
 * RING ALONE - a ring is a closed sub-chain, so rotating it needs none of
 * the rest of the file, and doing it that way is what keeps the cost off a
 * big complex holding one small ring.
 *
 * 🔴 THE PRICE IS THAT A RING-LOCAL PASS CANNOT SEE A BOND TO ANOTHER CHAIN,
 * AND `sec` USED TO BE AN OVERWRITE. `ladders` was already a union across
 * passes; `sec` was not, so a context-free pass beat a fully-informed one
 * wherever its margin was larger - which on a SHORT ring is nearly
 * everywhere. Measured on the fixture here, a 14-residue cyclic peptide
 * bound to GABARAP: two clean five-residue strands, CEEEEECCEEEEEC, came
 * back as CEECEECCEECCEC the moment the ring was closed. The strands are to
 * the PARTNER. Reported as the secondary structure getting worse when the
 * Cyclic box is ticked.
 *
 * The rule is that a rotation may ADD structure and never take it away - a
 * break destroys evidence, it does not create any - EXCEPT when the ring is
 * the whole structure, where the rotated pass sees everything pass 0 saw and
 * a coil it reports is a real finding. tests/cyclic_bench.js is the other
 * half of this: it scores isolated rings, where that exception is what holds
 * the seam at 87% Q3.
 *
 * The fixture is CA coordinates only, inlined below: *.pdb and tests/*.json
 * are both gitignored, so a separate data file would not be tracked and
 * nobody else could run this.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fail = 0;
const bad = (m) => { console.log('FAIL: ' + m); fail++; };

const sandbox = {
    window: { addEventListener() {}, dispatchEvent() {} },
    document: { createElement: () => ({ getContext: () => null }) },
    console, performance: { now: () => Date.now() },
    Event: function Event() {},
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/cartoon/geom.js'), 'utf8'),
    sandbox, { filename: 'geom.js' });
const C = sandbox.window.py2dmolCartoon;
if (!C || typeof C.assignSecondary !== 'function') {
    bad('cartoon/geom.js no longer exports assignSecondary');
    process.exit(1);
}

// The fixture, INLINE, because tests/*.json and *.pdb are both gitignored
// and a test whose input is not tracked is a test nobody else can run. CA
// coordinates from GABARAP_P3.pdb: a 14-residue cyclic peptide (ring 0..13)
// and the contiguous stretch of its partner within 10 A of it.
const RING = [0, 13];
const NAMES = ['CYS', 'ARG', 'ILE', 'VAL', 'ASP', 'ASP', 'GLY', 'GLU', 'TRP', 'ALA', 'ILE', 'ILE', 'GLU', 'CYS', 'ARG', 'VAL', 'PRO', 'VAL', 'ILE', 'VAL', 'GLU', 'LYS', 'ALA', 'PRO', 'LYS', 'ALA', 'ARG', 'ILE', 'GLY', 'ASP', 'LEU', 'ASP', 'LYS', 'LYS', 'LYS', 'TYR', 'LEU', 'VAL', 'PRO', 'SER', 'ASP', 'LEU', 'THR', 'VAL', 'GLY', 'GLN', 'PHE', 'TYR', 'PHE', 'LEU', 'ILE', 'ARG', 'LYS', 'ARG'];
const COORDS = [
    [1.839, -15.587, 6.437],
    [5.082, -13.623, 6.768],
    [6.713, -10.552, 5.248],
    [10.071, -10.991, 3.509],
    [12.264, -8.15, 2.264],
    [13.519, -7.825, -1.312],
    [15.139, -4.46, -1.943],
    [12.495, -1.727, -1.854],
    [9.731, -4.344, -1.696],
    [8.178, -6.117, 1.262],
    [6.733, -9.334, -0.17],
    [3.995, -11.215, 1.659],
    [4.471, -14.99, 1.519],
    [1.698, -17.341, 2.666],
    [-0.316, -10.509, -6.384],
    [-1.127, -6.792, -6.22],
    [1.332, -3.92, -5.617],
    [0.386, -1.684, -2.687],
    [1.896, 1.569, -1.409],
    [1.48, 1.853, 2.371],
    [2.207, 5.139, 4.168],
    [1.473, 6.698, 7.546],
    [-1.428, 9.169, 7.479],
    [-0.788, 12.839, 8.34],
    [-0.793, 13.575, 12.107],
    [-0.816, 9.867, 12.971],
    [0.995, 9.028, 16.222],
    [2.091, 5.549, 15.257],
    [5.334, 3.829, 14.274],
    [6.87, 4.186, 10.823],
    [7.163, 1.39, 8.283],
    [10.652, 0.781, 6.913],
    [9.282, 0.225, 3.397],
    [6.437, 1.715, 1.344],
    [6.063, -0.984, -1.309],
    [4.206, -4.226, -0.58],
    [3.54, -7.119, -2.953],
    [0.407, -8.776, -1.618],
    [-1.388, -12.033, -2.558],
    [-4.717, -11.178, -4.211],
    [-6.634, -13.595, -1.963],
    [-5.281, -12.146, 1.305],
    [-8.042, -10.389, 3.26],
    [-7.794, -6.816, 4.514],
    [-8.031, -8.246, 8.038],
    [-5.043, -10.504, 7.436],
    [-3.082, -7.577, 5.988],
    [-3.926, -5.528, 9.115],
    [-2.353, -8.242, 11.268],
    [0.842, -8.393, 9.208],
    [1.3, -4.611, 9.145],
    [0.632, -4.456, 12.889],
    [3.478, -6.922, 13.464],
    [5.743, -5.028, 11.057],
];

const coords = COORDS.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
const n = coords.length;
const types = new Array(n).fill('P');
const [lo, hi] = RING;
const opts = { names: NAMES };

const open = C.assignSecondary(coords, n, types, opts);
const ring = C.assignSecondary(coords, n, types,
    Object.assign({ rings: [[lo, hi]] }, opts));
const str = (s) => s.slice(lo, hi + 1).join('');
const openA = str(open.sec);
const ringA = str(ring.sec);
const count = (s, c) => s.split('').filter((x) => x === c).length;

console.log(`cyclic_partner: ${n} residues, ring ${lo}..${hi}`);
console.log(`  ring open   ${openA}`);
console.log(`  ring closed ${ringA}`);

// 🔴 THE INVARIANT, not the exact string: closing a ring may find structure
// the seam was hiding, and must never lose structure the open pass found.
// Stated as a per-residue rule so it cannot be satisfied by a coincidence of
// totals - swapping an H for an E elsewhere would keep the count.
const lost = [];
for (let i = lo; i <= hi; i++) {
    if (open.sec[i] !== 'C' && ring.sec[i] === 'C') lost.push(i);
}
if (lost.length) {
    bad(`closing the ring turned ${lost.length} residue(s) to coil at`
        + ` ${JSON.stringify(lost)} - open ${openA}, closed ${ringA}. A rotated`
        + ' pass runs on the ring ALONE, so it cannot see the strands this'
        + ' peptide makes with its partner; it may add structure and never'
        + ' take it away.');
}
// ...and the fixture has to be worth testing: a ring with no structure to
// lose would pass the rule above while proving nothing.
if (count(openA, 'E') + count(openA, 'H') < 6) {
    bad(`the fixture's open assignment is ${openA}, which has too little`
        + ' structure for the loss rule to mean anything');
}
// ...and the partner is untouched - it is not in a ring.
const bOpen = open.sec.slice(hi + 1).join('');
const bRing = ring.sec.slice(hi + 1).join('');
if (bOpen !== bRing) {
    bad(`the partner chain changed too: ${bOpen} -> ${bRing}`);
}

if (!fail) console.log('  ok: no structure lost, partner untouched');
process.exit(fail ? 1 : 0);
