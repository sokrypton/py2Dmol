/* A FILE'S CHAINS ARE DRAWN IN THE FILE'S ORDER.
 *
 *     node tests/chain_order.js
 *
 * The residue list convertParsedToFrameData builds for its neighbour checks is
 * also the list it walks to build the frame, and it was sorted by chain letter -
 * so a file written B then A came back A then B, and a page colouring by
 * position in its own file's order coloured the wrong chain. See
 * inFileChainOrder in src/io/parse.js.
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

/** CA-only PDB records for one chain along x, numbered from `from`. */
function chain(letter, names, y, from = 1) {
    return names.map((name, at) => 'ATOM  ' + String(at + 1).padStart(5) + '  CA  ' + name + ' '
        + letter + String(from + at).padStart(4) + '    ' + (at * 3.8).toFixed(3).padStart(8)
        + ((at % 2) * 1.5 + y).toFixed(3).padStart(8) + (0).toFixed(3).padStart(8) + '  1.00 20.00           C');
}

function frameOf(text) {
    const p = sb.parsePDB(text);
    const m = p.models || p.frames;
    return sb.convertParsedToFrameData(Array.isArray(m[0]) ? m[0] : m, null,
        p.chemCompMap, false, null, p.structConn, p.chemCompBondMap);
}

let bad = 0;
const fail = (m) => { console.log('FAIL ' + m); bad++; };
const pass = (m) => console.log('PASS  ' + m);
const runs = (fd) => fd.chains.filter((c, i) => i === 0 || fd.chains[i - 1] !== c).join('');

const res = ['ALA', 'GLY', 'SER', 'THR', 'VAL', 'LEU'];
const ba = frameOf([...chain('B', res.slice(0, 4), 0), ...chain('A', res, 20)].join('\n'));
if (runs(ba) !== 'BA') fail(`a file written B then A was drawn ${runs(ba)}`);
else pass('a file written B then A is drawn B then A');
const bLen = ba.chains.filter((c) => c === 'B').length;
if (bLen !== 4 || ba.chains.slice(0, 4).some((c) => c !== 'B')) fail(`the first four positions are not chain B's four`);
else pass('position 0..3 is chain B, the file\'s first four residues');

// mixed case, which localeCompare put a before B
const mixed = frameOf([...chain('B', res, 0), ...chain('a', res, 20), ...chain('A', res, 40)].join('\n'));
if (runs(mixed) !== 'BaA') fail(`B, a, A was drawn ${runs(mixed)}`);
else pass('B, a, A is drawn B, a, A');

// within a chain the residues are still in number order
const back = frameOf([...chain('A', res.slice(3), 0, 4), ...chain('A', res.slice(0, 3), 20, 1)].join('\n'));
if (back.residue_numbers.join(',') !== '1,2,3,4,5,6') fail(`a chain's residues came back ${back.residue_numbers.join(',')}`);
else pass('within a chain residues are in number order');

process.exit(bad ? 1 : 0);
