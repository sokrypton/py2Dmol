// WHAT EACH SHIPPED BUNDLE PUTS ON THE PAGE, AND WHAT IT MUST NOT.
//
//     node tests/bundles.js
//
// This replaces a check that ran tests/smoke.js against the notebook bundle and
// compared the picture with the sources'. That could not survive going
// GPU-only: node has no WebGL2, so the notebook and embed bundles now correctly
// draw nothing here, and the web bundle cannot even be loaded because
// src/app/*.js and panels/seq.js touch `document` while they load.
//
// What that check was really protecting is still worth protecting: that
// concatenating twenty-odd files and running terser over them leaves every
// cross-file name reachable. A bundle where `initializePy2DmolViewer` got
// renamed, or where a file was dropped from the list, fails here in
// milliseconds instead of in someone's notebook.
//
// The PICTURE is checked where a picture can exist: tests/minimal_input.py
// drives the notebook bundle in a real browser, tests/embed.py the embed
// bundle, and tests/multi_object.py index.html and therefore the web bundle.
//
// THE ABSENCES MATTER AS MUCH AS THE PRESENCES. Each bundle outside the website
// carries exactly one painter, and the whole point of that is lost the moment
// the other one is quietly along for the ride.
'use strict';
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

const DIR = 'py2Dmol/resources/bundles';
// THE FILENAME CARRIES THE LIBRARY'S NAME. A bundle gets copied into someone
// else's project, where `embed.min.js` says nothing about what it is.
const PREFIX = 'py2Dmol.';
const fileFor = (name) => `${DIR}/${PREFIX}${name}.min.js`;
let fail = 0;
const bad = (m) => { console.log('FAIL: ' + m); fail++; };

// name -> [must be defined], [must NOT be defined]
const EXPECT = {
    notebook: [
        ['initializePy2DmolViewer', 'OBJECT_STATE', 'normalizeConfig',
         'setupViewport', 'wireViewerUI', 'installMolParts',
         'py2dmolCartoon', 'py2dmolCartoonGPU', 'C2S'],
        // GPU-only: the 2D painter is not in this download, and SVG export is
        // hidden in the Save panel because of it.
        ['py2dmolCartoonPaint'],
    ],
    // ...the same embed on the CPU painter. Same names, opposite painters -
    // which is the whole contract: one bundle each, and nothing behind either.
    // It carries C2S and capture as well, because vector export is something
    // only the 2D painter can do.
    'embed.cpu': [
        ['py2Dmol', 'wireEmbedUI', 'setupViewport', 'initializePy2DmolViewer',
         'parseCIF', 'parsePDB', 'convertParsedToFrameData',
         'py2dmolCartoon', 'py2dmolCartoonPaint', 'C2S',
         'py2dmolPanel', 'wireViewerUI'],
        ['py2dmolCartoonGPU', 'Align', 'MSA', 'SEQ'],
    ],
    // ...and the same notebook drawn on the CPU, which viewer.py inlines for
    // gpu=False. Same names, opposite painters - one bundle each, nothing
    // behind either, exactly as the two embeds are. It is the only notebook
    // that can save an SVG, so C2S has to be here and be reachable.
    'notebook.cpu': [
        ['initializePy2DmolViewer', 'OBJECT_STATE', 'normalizeConfig',
         'setupViewport', 'wireViewerUI', 'installMolParts',
         'py2dmolCartoon', 'py2dmolCartoonPaint', 'C2S'],
        ['py2dmolCartoonGPU'],
    ],
    // ...and the notebook without the cartoon geometry, which viewer.py inlines
    // when nothing on the page can ask for a cartoon.
    'notebook.tube': [
        ['initializePy2DmolViewer', 'OBJECT_STATE', 'normalizeConfig',
         'setupViewport', 'wireViewerUI', 'installMolParts',
         'py2dmolCartoonGPU', 'C2S'],
        ['py2dmolCartoon', 'py2dmolCartoonPaint'],
    ],
    embed: [
        ['py2Dmol', 'wireEmbedUI', 'setupViewport', 'initializePy2DmolViewer',
         'parseCIF', 'parsePDB', 'convertParsedToFrameData',
         'py2dmolCartoon', 'py2dmolCartoonGPU',
         // ...and the notebook's own panel and wiring, which controls:true
         // mounts rather than growing a third set of controls
         'py2dmolPanel', 'wireViewerUI'],
        // no 2D painter, no save UI, no side panels, no alignment
        ['py2dmolCartoonPaint', 'Align', 'MSA', 'SEQ'],
    ],
};

// A sandbox with no DOM. Everything above registers at load time without one;
// anything that needs a document is a file that does not belong in a bundle
// meant to be loaded before the page is ready.
const makeSandbox = () => {
    const sb = {
        window: { addEventListener() {}, dispatchEvent() {}, removeEventListener() {} },
        console: { log() {}, warn() {}, error() {} },
        performance: { now: () => 0 },
        navigator: {}, Event: function () {},
        document: {
            createElement: () => ({ getContext: () => null, style: {},
                appendChild() {}, setAttribute() {} }),
            addEventListener() {}, removeEventListener() {},
            dispatchEvent() {}, querySelector: () => null,
            getElementById: () => null, body: { appendChild() {} },
            currentScript: { src: '' },
        },
    };
    sb.window.window = sb.window;
    sb.window.document = sb.document;
    sb.self = sb.window;
    sb.globalThis = sb;
    return vm.createContext(sb);
};

// A TOP-LEVEL `const` IS NOT A PROPERTY OF THE GLOBAL OBJECT. `function f(){}`
// and `var` become sb.f; `const OBJECT_STATE = [...]` does not, so reading the
// sandbox object said the notebook bundle had lost it when it had not. Ask the
// context to evaluate the name instead, which is what a later script in the
// same page does.
// TWO WAYS A BUNDLE PUBLISHES A NAME, and neither is visible the same way here.
//
// A top-level `const OBJECT_STATE = [...]` does NOT become a property of the
// global object - only `function` and `var` do - so reading the sandbox object
// said the notebook had lost it when it had not. And `window.py2dmolCartoon =`
// writes to sb.window, which in this context is an ordinary object rather than
// the global itself, so the bare identifier is not defined either. In a browser
// the two are the same thing; in a vm context they are not.
//
// So: ask the context to evaluate the bare name, and also look on window.
const has = (sb, name) => {
    if (sb.window[name] !== undefined) return true;
    try {
        return vm.runInContext(`typeof ${name} !== 'undefined'`, sb) === true;
    } catch (e) {
        return false;
    }
};

for (const [name, [want, unwant]] of Object.entries(EXPECT)) {
    const file = fileFor(name);
    if (!fs.existsSync(file)) {
        bad(`${file} has not been built - run: python3 tools/bundle.py build`);
        continue;
    }
    // ...it parses. Cheap, and it is the failure a bad terser flag produces.
    try {
        execFileSync('node', ['--check', file], { stdio: 'pipe' });
    } catch (e) {
        bad(`${file} does not parse: ${String(e.stderr || e).slice(0, 200)}`);
        continue;
    }
    const sb = makeSandbox();
    try {
        vm.runInContext(fs.readFileSync(file, 'utf8'), sb, { filename: name });
    } catch (e) {
        bad(`${file} threw while loading: ${String(e.message).slice(0, 200)}`);
        continue;
    }
    const missing = want.filter((n) => !has(sb, n));
    const extra = unwant.filter((n) => has(sb, n));
    console.log(`  ${name}: ${want.length - missing.length}/${want.length} present,`
        + ` ${unwant.length - extra.length}/${unwant.length} correctly absent`);
    for (const n of missing) {
        bad(`${name}.min.js does not define ${n} - a file is missing from the`
            + ' bundle, or terser renamed a name reached across files');
    }
    for (const n of extra) {
        bad(`${name}.min.js defines ${n}, which it is meant not to carry`);
    }
}

// ...and the web bundle, which cannot be loaded here at all - so check only
// that it parses. tests/multi_object.py runs it in a browser.
try {
    execFileSync('node', ['--check', `${DIR}/py2Dmol.web.min.js`], { stdio: 'pipe' });
    console.log('  web: parses (a browser runs it - tests/multi_object.py)');
} catch (e) {
    bad(`${DIR}/py2Dmol.web.min.js does not parse: ${String(e.stderr || e).slice(0, 200)}`);
}

// --- and the sizes the documentation quotes ---------------------------------
// README.md and embed.html both tell a reader how big these downloads are, and
// a number in prose is a promise like any other. Checked loosely - within a
// tenth - because the point is catching a bundle that has changed shape, not
// policing a rebuild that moved it by a kilobyte.
for (const doc of ['README.md', 'embed.html', 'CHANGELOG.md']) {
    const text = fs.readFileSync(doc, 'utf8');
    let found = 0;
    for (const name of ['embed', 'embed.cpu']) {
        // `py2Dmol.embed.min.js` ... `414 KB`, in a table row or a sentence
        const re = new RegExp(`${(PREFIX + name).replace(/[.\-]/g, '\\$&')}\\.min\\.js[^\\n]*?(\\d+)\\s*KB`);
        const m = re.exec(text);
        if (!m) continue;
        found++;
        const said = Number(m[1]);
        const real = Math.round(fs.statSync(fileFor(name)).size / 1024);
        if (Math.abs(said - real) > Math.max(12, real * 0.1)) {
            bad(`${doc} says ${name}.min.js is ${said} KB; it is ${real} KB`);
        }
    }
    if (!found) {
        bad(`${doc} quotes no bundle size any more - if that is deliberate,`
            + ' drop it from this list rather than leaving a check that passes'
            + ' by finding nothing');
    }
}

if (!Object.keys(EXPECT).length) bad('nothing is checked - this would pass forever');
console.log(fail ? `${fail} problems` : 'ok');
process.exit(fail ? 1 : 0);
