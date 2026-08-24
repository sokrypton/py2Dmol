#!/usr/bin/env node
// WHAT A LINE RANGE READS BUT DOES NOT DECLARE - the pre-flight for cutting a
// block out of one file and into another.
//
//     node tools/free_vars.js src/core/mol.js 4046 4431
//     node tools/free_vars.js src/cartoon/geom.js 2986 9855
//
// Ported from ../aoe/tools/free-vars.js, which exists for the same reason: a
// block that closed over a local in the function it was cut from throws
// ReferenceError at runtime, in a branch nobody exercised, long after the diff
// was reviewed. The three buckets are the whole point:
//
//   MUST HANDLE - declared somewhere in this file OUTSIDE the range, and not at
//     column zero. For core/mol.js that means a local of
//     `initializePy2DmolViewer`, which is the 16,000-line closure everything
//     lives in: Vec3, hexToRgb, DEFAULT_CONFIG, every colour table. A mixin
//     file at module scope cannot see any of them, so each one has to be
//     hoisted, passed, or recomputed before the range can move.
//
//   fine - declared at column zero in one of the manifest's files, so it is a
//     real global and survives the move. tools/bundle.py is asked which files
//     those are, rather than a second list being kept here.
//
//   unresolved - the heuristic did not place it. Usually a property or a
//     parameter it failed to strip; occasionally the interesting one.
//
// HEURISTIC, NOT A PARSER. It strips comments, strings, property accesses and
// object keys, then diffs identifiers against declarations. Treat the output as
// a checklist to read, not as proof - but it turns a runtime surprise into
// something you can look at before committing.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.dirname(__dirname);

const KEYWORDS = new Set((
    'let const var function if else return for while new this true false null undefined typeof of in '
  + 'break continue switch case default do try catch finally throw instanceof delete void class extends '
  + 'yield async await arguments super static get set').split(' '));

const BUILTINS = new Set((
    'Math JSON Object Array Set Map WeakMap WeakSet String Number Boolean Date RegExp Promise Proxy '
  + 'Reflect Error TypeError RangeError Infinity NaN parseInt parseFloat isNaN isFinite '
  + 'Uint8Array Uint8ClampedArray Uint16Array Uint32Array Int8Array Int16Array Int32Array '
  + 'Float32Array Float64Array ArrayBuffer DataView Symbol BigInt '
  + 'window document console performance requestAnimationFrame cancelAnimationFrame '
  + 'setTimeout setInterval clearTimeout clearInterval queueMicrotask '
  + 'localStorage sessionStorage navigator location history screen '
  + 'Image Audio Blob File FileReader URL URLSearchParams FormData Headers Request Response fetch '
  + 'Worker SharedWorker importScripts MessageChannel BroadcastChannel MutationObserver '
  + 'ResizeObserver IntersectionObserver MediaRecorder AudioContext '
  + 'Event CustomEvent EventTarget DOMParser XMLSerializer XMLHttpRequest '
  + 'Path2D DOMMatrix ImageData OffscreenCanvas createImageBitmap '
  + 'TextEncoder TextDecoder atob btoa crypto structuredClone globalThis self module require exports '
  + 'encodeURIComponent decodeURIComponent encodeURI decodeURI alert prompt confirm'
).split(' '));

// REGEX LITERALS COUNT AS STRINGS. aoe's version strips comments and quotes but
// not regexes, and the difference is not academic: `/rgb\((\d+),\s*(\d+)\)/`
// contributes `rgb` and - via the escape `\d` - a bare `d`, and both were
// reported as free variables of the canvas2svg block. Two false positives out of
// two on the first range this tool was pointed at.
//
// A `/` starts a regex when what precedes it cannot end an expression: an
// operator, an opening bracket, a comma, a semicolon, or `return`/`typeof` and
// friends. Anything else is division. That is the standard heuristic and it is
// wrong only for code that divides by a parenthesised expression immediately
// after a keyword, which does not appear here.
function stripRegex(s) {
    let out = ''; let i = 0;
    const startsRegex = (before) => /(^|[=(,:;[!&|?{}+\-*%~^]|\b(?:return|typeof|case|in|of|new|delete|void|instanceof))\s*$/
        .test(before);
    while (i < s.length) {
        const c = s[i];
        if (c !== '/') { out += c; i++; continue; }
        if (!startsRegex(out.slice(-24))) { out += c; i++; continue; }
        // scan to the closing slash, honouring escapes and character classes
        let j = i + 1; let inClass = false; let closed = false;
        for (; j < s.length; j++) {
            const d = s[j];
            if (d === '\\') { j++; continue; }
            if (d === '\n') break;
            if (inClass) { if (d === ']') inClass = false; continue; }
            if (d === '[') { inClass = true; continue; }
            if (d === '/') { closed = true; break; }
        }
        if (!closed) { out += c; i++; continue; }
        while (j + 1 < s.length && /[dgimsuvy]/.test(s[j + 1])) j++;   // flags
        // a token with no identifier characters in it - an earlier placeholder
        // of '/RE/' put `RE` into every result
        out += '0'; i = j + 1;
    }
    return out;
}

const strip = (s) => stripRegex(s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""'));

/** Identifiers, minus property accesses (`.foo`) and object-literal keys (`foo:`). */
function idents(code) {
    const out = new Set();
    const noProp = code
        .replace(/\.\s*([A-Za-z_$][\w$]*)/g, '.')
        .replace(/([A-Za-z_$][\w$]*)\s*:/g, ':');
    for (const m of noProp.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
    return out;
}

// Binding names only. Taking the INITIALIZER too is the subtle failure that
// makes this tool lie: `const halfW = someClosureLocal ? a : b` would mark
// someClosureLocal as declared, hiding the very free variable being hunted.
function declArators(list) {
    const names = [];
    let depth = 0; let buf = '';
    for (const c of list) {
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        if (c === ',' && depth === 0) { names.push(buf); buf = ''; continue; }
        buf += c;
    }
    names.push(buf);
    // Left of the first `=` is the binding pattern; the rest is an expression.
    // AND LEFT OF A TOP-LEVEL ` of ` / ` in ` too, for a for-of head, which has
    // no `=` at all: `for (const obj of arr[viewerId])` was taking the whole
    // text as a pattern and declaring obj, of, arr AND viewerId. That is a
    // false NEGATIVE - the range writes to viewerId and read as closing over
    // nothing, which is the direction that breaks an extraction.
    const head = (nm) => {
        const upto = nm.split('=')[0];
        const m = /^([\s\S]*?)\s+(?:of|in)\s+/.exec(upto);
        return m ? m[1] : upto;
    };
    return names.flatMap((nm) => [...head(nm).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

function declared(code) {
    const out = new Set();
    const re = /\b(?:let|const|var)\s+/g;
    let m;
    while ((m = re.exec(code))) {
        let i = m.index + m[0].length; let depth = 0;
        while (i < code.length && !(code[i] === ';' && depth === 0)) {
            if ('([{'.includes(code[i])) depth++;
            else if (')]}'.includes(code[i])) { if (depth === 0) break; depth--; }
            i++;
        }
        for (const nm of declArators(code.slice(m.index + m[0].length, i))) out.add(nm);
    }
    // A PARAMETER LIST CAN CONTAIN PARENTHESES. `[^)]*` stops at the first
    // one, so `mergedObjectSet(field, nullMeans = objectStateAbsent(field))`
    // matched nothing at all and neither the method's name nor either of its
    // parameters was ever declared - three false positives from one default
    // argument. One level of nesting is enough for everything here.
    for (const mm of code.matchAll(/\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(((?:[^()]|\([^()]*\))*)\)/g)) {
        if (mm[1]) out.add(mm[1]);
        for (const nm of declArators(mm[2] || '')) out.add(nm);
    }
    for (const mm of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(mm[1]);
    for (const mm of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
        for (const nm of mm[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
    }
    for (const mm of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/gm)) out.add(mm[1]);
    for (const mm of code.matchAll(/\bfor\s*\(\s*(?:let|const|var)?\s*([A-Za-z_$][\w$]*)/g)) out.add(mm[1]);
    for (const mm of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(mm[1]);
    // ...and class methods - the NAME and its PARAMETERS. Taking only the name
    // left every method's arguments looking free: `constructor(x, y, z)` on
    // Vec3 reported y and z as enclosing-scope locals of a range that declares
    // them three characters earlier.
    // ...AND NOT A CONTROL-FLOW STATEMENT. `if (...) {` and `for (...) {` have
    // exactly the shape of a method definition, so this rule was declaring
    // every identifier that appeared in a CONDITION. `if (viewerId) {` declared
    // viewerId, and the range that writes to it read as closing over nothing -
    // a false NEGATIVE, which is the direction that breaks an extraction rather
    // than merely annoying the reader.
    const NOT_A_METHOD = /^(?:if|for|while|switch|catch|with|do|else|return|function|typeof|new|delete|void|in|of|case|await|yield)$/;
    for (const mm of code.matchAll(/\n\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{/g)) {
        if (NOT_A_METHOD.test(mm[1])) continue;
        out.add(mm[1]);
        // ...BINDINGS ONLY, through declArators. Taking every identifier in the
        // list would declare the function in a default value too - `nullMeans =
        // objectStateAbsent(field)` would mark objectStateAbsent as local and
        // hide it if it were genuinely free.
        for (const nm of declArators(mm[2] || '')) out.add(nm);
    }
    return out;
}

/**
 * The global surface: declarations at COLUMN ZERO across the manifest's files,
 * plus everything hung on `window`.
 *
 * Column zero is the test because that is what survives a move. py2Dmol's
 * files are IIFEs and core/mol.js is one 16,000-line factory function, so
 * anything indented is somebody's local however module-ish it looks - which is
 * exactly the distinction this tool exists to draw.
 *
 * The file list comes from tools/bundle.py rather than a second copy here.
 */
function globals() {
    const out = new Set();
    let files;
    try {
        files = execFileSync('python3', [path.join(ROOT, 'tools', 'bundle.py'), 'show'],
            { encoding: 'utf8' })
            .split('\n').map((l) => (l.match(/\s((?:py2Dmol|web)\/\S+\.js)/) || [])[1])
            .filter(Boolean);
    } catch (e) {
        console.error('could not ask tools/bundle.py for the file list: ' + e.message);
        process.exit(2);
    }
    for (const rel of files) {
        const s = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        for (const m of s.matchAll(/^(?:function|const|let|var|class)\s+([^;=\n(){]+)/gm)) {
            for (const nm of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
        }
        for (const m of s.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
    }
    return out;
}

const file = process.argv[2];
const from = +process.argv[3];
const to = +process.argv[4];
if (!file || !from || !to) {
    console.error('usage: node tools/free_vars.js <file> <fromLine> <toLine>');
    process.exit(2);
}

const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
if (to > lines.length) {
    console.error(`${file} has ${lines.length} lines; asked for ${to}`);
    process.exit(2);
}
const range = strip(lines.slice(from - 1, to).join('\n'));
// everything OUTSIDE the range, which is what the range could be closing over
const outside = strip(lines.slice(0, from - 1).concat(lines.slice(to)).join('\n'));

const used = idents(range);
const here = declared(range);
const there = declared(outside);
const glob = globals();

const free = [...used]
    .filter((n) => !here.has(n) && !KEYWORDS.has(n) && !BUILTINS.has(n)).sort();
const asGlobal = free.filter((n) => glob.has(n));
const asEnclosing = free.filter((n) => !glob.has(n) && there.has(n));
const unknown = free.filter((n) => !glob.has(n) && !there.has(n));

const wrap = (a) => (a.length ? a.join(', ').replace(/(.{76}[^,]*, )/g, '$1\n  ') : '(none)');
console.log(`range ${file}:${from}-${to}  (${to - from + 1} lines)\n`);
console.log(`MUST HANDLE - enclosing-scope locals (${asEnclosing.length}):\n  ${wrap(asEnclosing)}\n`);
console.log(`globals, fine (${asGlobal.length}):\n  ${wrap(asGlobal)}\n`);
console.log(`unresolved - likely properties or params the heuristic missed (${unknown.length}):\n  ${wrap(unknown)}`);
