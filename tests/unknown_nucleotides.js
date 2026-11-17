/* THE DICTIONARY'S UNKNOWN NUCLEOTIDES, DN AND N, ARE NUCLEIC.
 *
 *     node tests/unknown_nucleotides.js
 *
 * AlphaFold 3 writes an unknown base as DN (DNA) or N (RNA), and LocalFold's
 * design page sketches a strand still to be designed as a chain of them, one
 * C4' each. Neither name was in STANDARD_NUCLEIC_ACIDS, and a C4' alone has no
 * sugar ring for the structural fallback, so the strand was not a polymer.
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

/** One C4' a residue, 6.5 A apart along x. */
function strand(chain, name, n) {
    return Array.from({length: n}, (_, at) => 'ATOM  ' + String(at + 1).padStart(5) + "  C4' "
        + name.padStart(3) + ' ' + chain + String(at + 1).padStart(4) + '    '
        + (at * 6.5).toFixed(3).padStart(8) + (0).toFixed(3).padStart(8) + (0).toFixed(3).padStart(8)
        + '  1.00 20.00           C');
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
const types = (fd, chain) => fd.chains.map((c, i) => (c === chain ? fd.position_types[i] : '')).join('');

const fd = frameOf([...strand('A', 'DN', 6), ...strand('B', 'N', 5), ...strand('C', 'DA', 4)].join('\n'));
if (types(fd, 'A') !== 'DDDDDD') fail(`a strand of DN came back ${JSON.stringify(types(fd, 'A'))}`);
else pass('a strand of DN is six DNA positions');
if (types(fd, 'B') !== 'RRRRR') fail(`a strand of N came back ${JSON.stringify(types(fd, 'B'))}`);
else pass('a strand of N is five RNA positions');
if (types(fd, 'C') !== 'DDDD') fail(`the DA control came back ${JSON.stringify(types(fd, 'C'))}`);
else pass('a strand of DA, the control, is DNA as before');

process.exit(bad ? 1 : 0);
