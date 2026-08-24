// Keep the TM-align half of src/align/align.js in step with foldjs.
//
//   node tests/vendor_tmalign.mjs           # check   (exit 1 if it differs)
//   node tests/vendor_tmalign.mjs --write   # rewrite the generated region
//
// THE ALGORITHM IS NOT MAINTAINED HERE. foldjs's own README exists because
// copied modules drift, and this repo is a second copy of one of them. So the
// copy is GENERATED: viewer-align.js carries the upstream file verbatim between
// two markers, this script puts it there, and tests/align.js runs this script in
// check mode and fails on any difference. A change made here fails; a change
// made upstream is picked up by rerunning with --write and shows up as a
// reviewable diff.
//
// ONE FILE AND NOT TWO. The algorithm and the viewer's side of it used to be
// separate scripts, which meant two <script> tags, two names in the worker's
// importScripts, and two ways for a page to load half of it. They are one
// file with a seam inside it instead: the markers are the seam, and they are
// enforced rather than remembered.
//
// The derivation is ONE transform: `export ` is dropped from the eight
// top-level declarations. The upstream file is an ES module; py2Dmol's
// resources are classic scripts that the notebook build INLINES into one HTML
// file (viewer.py:1313), where a module cannot go and a fetch has nothing to
// fetch. Nothing else changes - the 1,433 lines of numerics in between are
// byte-identical to the file whose parity against TMalign.cpp is checked
// upstream to 1.1e-16.
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const UPSTREAM = path.resolve(HERE, '../../foldjs/lib/tmalign.js');
const TARGET = path.resolve(HERE, '../src/align/align.js');

export const BEGIN = '// >>> BEGIN GENERATED: foldjs/lib/tmalign.js';
export const END = '// <<< END GENERATED';

/** The target file with the generated region replaced by the derivation. */
export function spliced(target, upstream) {
    const a = target.indexOf(BEGIN);
    const b = target.indexOf(END);
    if (a < 0 || b < 0 || b < a) {
        throw new Error('viewer-align.js has lost its generated-region markers');
    }
    const head = target.slice(0, target.indexOf('\n', a) + 1);
    return head + upstream.replace(/^export /gm, '') + target.slice(b);
}

if (process.argv[1] && process.argv[1].endsWith('vendor_tmalign.mjs')) {
    if (!fs.existsSync(UPSTREAM)) {
        console.error('no ../foldjs checkout at ' + UPSTREAM);
        process.exit(2);
    }
    const have = fs.readFileSync(TARGET, 'utf8');
    const want = spliced(have, fs.readFileSync(UPSTREAM, 'utf8'));
    if (process.argv.includes('--write')) {
        fs.writeFileSync(TARGET, want);
        console.log(`wrote the generated region of ${TARGET} (${want.length} bytes total)`);
    } else if (have === want) {
        console.log('viewer-align.js: its TM-align is in step with foldjs');
    } else {
        console.error('viewer-align.js: its TM-align has DRIFTED from foldjs'
            + ' - rerun with --write');
        process.exit(1);
    }
}
