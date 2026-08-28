// LIFTING SHIPPED CODE OUT OF THE SOURCE, from however many files it lives in.
//
//     const L = require('./lift.js');
//     L.method('pickResidueAt')      // a class method, at any indent
//     L.staticGet('ELEMENT_COLORS')  // a `static get NAME()`
//     L.topFunction('selectionBandFor')
//     L.constLine('SIDECHAIN_WIDTH') // a single-line `const NAME = ...;`
//     L.constExpr('isPerspective')   // a `const NAME = ...;` over several lines
//     L.klass('Vec3')
//     L.between('// >>> A', '// <<< B')
//     L.src                          // every source file, concatenated
//
// core/mol.js needs a DOM to instantiate, so rather than mock a browser the
// tests run the SHIPPED TEXT of individual methods against a mock canvas. That
// only works while the text can be found, and for a long time "found" meant
// `src.indexOf('\n        ' + name + '(')` - an exact eight spaces, which is a
// method inside a class inside a factory function.
//
// TWO THINGS WERE WRONG WITH THAT, and both block splitting the file up.
//
// ONE FILE. The path was baked in, so a method that moved to a sibling file
// simply vanished, and 123 lifts failed at once with `method not found:
// _inertiaAllowed` and no hint that the file list was the problem. SOURCES
// below is the list, and it is the only place that knows.
//
// AN EXACT INDENT. Hoisting the class out of the factory moves every method
// from eight spaces to four; wrapping a chunk in an IIFE moves it the other
// way. Either way the whole harness fails, invisibly in a diff, and the first
// person to run a formatter over the file does the same damage. So the match
// here is indent-agnostic, and it discriminates a definition from a call site
// the way a reader does rather than by counting spaces:
//
//     A DEFINITION IS FOLLOWED BY `{`. A CALL IS FOLLOWED BY `;` OR `)`.
//
// `foo(a, b) {` is a definition wherever it sits; `this.foo(a, b);` is not, and
// neither is `foo(x)` inside an expression. That is the whole rule, and it is
// stronger than the indent test it replaces - the old one relied on the
// definition happening to come before any call site written at exactly eight
// spaces, which was true by luck and commented as a hazard twice.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);

// THE RENDERER, IN LOAD ORDER. Every scan in every test reads this list, so a
// file that splits out of core/mol.js is added here once and the tests keep
// working. Files that are their own subsystem (cartoon, gpu, align, pae, seq,
// msa, scatter) are NOT here: nothing lifts methods out of them through this,
// and pulling them in would make every `indexOf` ambiguous.
const SOURCES = [
    // The registry and the ligand cache moved out of core/mol.js; both are
    // still lifted from - the OBJECT_STATE slab by its markers, objectStateAbsent
    // by name - so this list is how the tests follow them.
    'src/core/objstate.js',
    // parts of Pseudo3DRenderer that live in sibling files - the tests lift
    // their methods exactly as if they were still in the class
    'src/parts/shadow.js',
    'src/parts/ui.js',
    'src/parts/multi.js',
    'src/parts/align.js',
    'src/parts/savepanel.js',
    'src/parts/capture.js',
    'src/parts/clip.js',
    'src/core/mol.js',
];

/** Each source's text, in order, with the path it came from. */
const files = SOURCES.map((rel) => ({
    rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8'),
}));

/** All of them, concatenated. What a whole-file scan should read. */
const src = files.map((f) => f.text).join('\n');

// THE PARSER AND ITS NEIGHBOURS, likewise. web/utils.js became three files -
// maths, parsing and the GIF encoder - and a dozen scans in the tests read it
// by name. They read this instead, so the next split there costs one line here.
// ...and sidechains.js, which was cut OUT of parse.js so the notebook could
// have the chemistry without the parser. Anything lifting a side-chain table
// or a backbone set looks here now.
// 🔴 src/io/bonds.js BEFORE parse.js, WHICH CALLS IT. The element-pair bond
// table was inside parse.js and is now shared with core/mol.js, and this list
// is what a node test evaluates as "the utilities": leaving the new file out
// left `bondMaxFor` undefined in that blob while the parser still called it -
// green only because no test had yet reached that line. This is the list that
// has to learn about a split, and it is the third time (math.js, then
// sidechains.js, now bonds.js).
const UTILS = ['src/io/math.js', 'src/io/sidechains.js', 'src/io/bonds.js',
               'src/io/parse.js', 'src/io/gif.js'];
// ...and the cartoon renderer, likewise split: cartoon/geom.js builds the
// primitive list and cartoon/paint2d.js paints it. A scan for a drawing call
// has to read both, and loading the pair in THIS order is what a page does -
// the painter reads its shading vocabulary from the geometry file at load time.
const CARTOON = ['src/cartoon/geom.js',
    'src/cartoon/paint2d.js'];
// ...and the web app, split by what each part is for. A scan for a handler has
// to read all of them; main.js first, because it declares the shared state.
const APP = ['src/app/main.js', 'src/app/selection.js', 'src/app/objects.js',
    'src/app/fetch.js', 'src/app/scatter.js', 'src/app/session.js'];
// ...and the best-view search, which used to be six hundred lines inside
// src/app/main.js and is a part now. Named here so the next move costs one line
// rather than a hunt through whichever test lifts its arithmetic.
const ORIENT = ['src/parts/orient.js'];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const utils = UTILS.map(read).join('\n');
const cartoon = CARTOON.map(read).join('\n');
const app = APP.map(read).join('\n');
const orient = ORIENT.map(read).join('\n');

const where = () => (SOURCES.length === 1 ? SOURCES[0] : SOURCES.join(', '));

/** Brace-match forward from the `{` at or after `from`. Returns its index. */
function matchBrace(text, from) {
    let i = text.indexOf('{', from);
    if (i < 0) return -1;
    let d = 0;
    for (; i < text.length; i++) {
        if (text[i] === '{') d++;
        else if (text[i] === '}' && !--d) return i;
    }
    return -1;
}

/** Paren-match forward from the `(` at `from`. Returns the closing index. */
function matchParen(text, from) {
    let d = 0;
    for (let i = from; i < text.length; i++) {
        if (text[i] === '(') d++;
        else if (text[i] === ')' && !--d) return i;
    }
    return -1;
}

/**
 * A class method's source text, wherever it lives and at whatever indent.
 *
 * Candidates are `NAME(` sitting at the start of a line (whitespace only
 * before it, optionally `async`), and a candidate is the definition only if
 * its parameter list is followed by `{`. That skips call sites without caring
 * how far either is indented.
 */
function method(name) {
    const re = new RegExp('\\n([ \\t]*)(async\\s+)?' + name + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
        const open = src.indexOf('(', m.index + m[0].length - 1);
        const close = matchParen(src, open);
        if (close < 0) continue;
        // ...the definition test: a body follows, not a `;` or an operator
        const after = src.slice(close + 1).match(/^\s*/)[0].length;
        if (src[close + 1 + after] !== '{') continue;
        const end = matchBrace(src, close + 1);
        if (end < 0) continue;
        return src.slice(m.index, end + 1);
    }
    throw new Error(`method not found in ${where()}: ${name}`
        + ' - it may have moved to a file that is not in lift.js SOURCES');
}

/**
 * A `static get NAME() { ... }`, at any indent - or the same member after it
 * has moved into a part file, where it is written `get NAME()` inside a
 * `statics: {}` object and the `static` keyword is gone. Both spellings mean
 * the same thing to installMolParts, so both have to be findable here.
 */
function staticGet(name) {
    const re = new RegExp('\\n[ \\t]*(?:static\\s+)?get\\s+' + name + '\\s*\\(\\s*\\)');
    const m = re.exec(src);
    if (!m) throw new Error(`static get not found in ${where()}: ${name}`);
    const end = matchBrace(src, m.index + m[0].length);
    // ...ALWAYS RETURNED WITH `static`, whichever spelling it was found in.
    // Callers splice this into a class body, and `get X()` there is an INSTANCE
    // getter: this.constructor.X comes back undefined and the failure reads as
    // "cannot read properties of undefined", nowhere near the cause.
    const text = src.slice(m.index, end + 1);
    return /^\s*static\b/.test(text.replace(/^\n/, ''))
        ? text : text.replace(/(\n[ \t]*)get\b/, '$1static get');
}

/** A top-level `function NAME(...) { ... }`, at any indent. */
function topFunction(name) {
    const re = new RegExp('\\n[ \\t]*function\\s+' + name + '\\s*\\(');
    const m = re.exec(src);
    if (!m) throw new Error(`function not found in ${where()}: ${name}`);
    const end = matchBrace(src, m.index + m[0].length);
    return src.slice(m.index, end + 1).trim();
}

/** A `class NAME { ... }`, at any indent. */
function klass(name) {
    const re = new RegExp('\\n[ \\t]*class\\s+' + name + '\\s*\\{');
    const m = re.exec(src);
    if (!m) throw new Error(`class not found in ${where()}: ${name}`);
    const end = matchBrace(src, m.index + m[0].length - 1);
    return src.slice(m.index, end + 1).trim();
}

/** A `const NAME = ...;` written on ONE line. Returned without the keyword. */
function constLine(name) {
    const line = src.split('\n').find((l) => l.trim().startsWith('const ' + name + ' ='));
    if (!line) throw new Error(`single-line const not found in ${where()}: ${name}`);
    return line.trim().replace(/^const /, '');
}

/** A `const NAME = ...;` that may run over several lines. */
function constExpr(name) {
    const re = new RegExp('\\n[ \\t]*const ' + name + ' = [\\s\\S]*?;\\n');
    const m = re.exec(src);
    if (!m) throw new Error(`const not found in ${where()}: ${name}`);
    return m[0].trim().replace(/^const /, '');
}

/**
 * The text between two marker comments, markers included.
 *
 * For a slab that is a region rather than one declaration - the OBJECT_STATE
 * table and its remappers. That used to be sliced from `const OBJECT_STATE = [`
 * to `function initializePy2DmolViewer(`, which quietly required the table to
 * sit immediately before the factory and nothing to be inserted between them.
 * Markers say it out loud instead, and survive the region moving to its own
 * file.
 */
function between(beginMark, endMark) {
    const a = src.indexOf(beginMark);
    const b = src.indexOf(endMark, a + 1);
    if (a < 0 || b < 0) {
        throw new Error(`markers not found in ${where()}: ${beginMark} / ${endMark}`
            + ' - if the region moved, add its file to lift.js SOURCES');
    }
    return src.slice(a, b + endMark.length);
}

/**
 * The style panel's rows, as data.
 *
 * The panel used to be markup in index.html and again in viewer.html, and a
 * dozen assertions read it by scanning that HTML. It is one table in
 * parts/panel.js now, so they read the table - which is both the source of
 * truth and far easier to assert against than nested <div>s.
 */
function panelRows() {
    const sb = {
        window: {},
        document: { createElement: () => ({ setAttribute() {}, appendChild() {} }),
            createDocumentFragment: () => ({ appendChild() {} }) },
        console,
    };
    sb.window.window = sb.window;
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT,
        'src/parts/panel.js'), 'utf8'), sb, { filename: 'panel' });
    const rows = sb.window.py2dmolPanel && sb.window.py2dmolPanel.STYLE_PANEL_ROWS;
    if (!rows || !rows.length) {
        throw new Error('parts/panel.js no longer publishes STYLE_PANEL_ROWS'
            + ' - the panel moved again and these assertions read nothing');
    }
    return rows;
}

/** Every control in the panel, flattened, keyed by id. */
function panelItems() {
    const out = {};
    for (const row of panelRows()) for (const item of row) out[item.id] = item;
    return out;
}

module.exports = { SOURCES, files, src, ROOT, UTILS, utils, CARTOON, cartoon, APP, app, ORIENT, orient, read,
    panelRows, panelItems,
    method, staticGet, topFunction, klass, constLine, constExpr, between,
    matchBrace, matchParen };
