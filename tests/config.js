// EVERY SETTING PYTHON SENDS HAS TO SURVIVE THE TRANSLATION.
//
//     node tests/config.js
//
// py2Dmol.view(...) takes flat keyword arguments, _nest_config in viewer.py
// turns them into a nested config, and normalizeConfig in core/mol.js rebuilds
// that config FIELD BY FIELD before the renderer sees it. The last step is the
// dangerous one: a key it does not name is a key it throws away, silently, and
// the flag goes on existing everywhere else - in the signature, the docstring,
// the default - while doing nothing.
//
// THAT IS NOT HYPOTHETICAL. `gpu` was missing from the rendering block for as
// long as the flag existed, so py2Dmol.view(gpu=True) never once turned the
// GPU on; every notebook drew on the CPU path. The carry-over loop at the end
// of normalizeConfig did not save it, because that walks TOP-LEVEL keys and
// `rendering` is already in knownKeys. The web app hid the bug by not using
// this path at all: it assigns renderer.useGPU straight from its checkbox.
//
// So this does not test one key. It reads the keys OUT OF viewer.py - every
// `config["rendering"]["x"] = ...` it performs - and checks each one arrives.
// A new flag is covered the day it is added, without anyone remembering to.
'use strict';
const fs = require('fs');
const vm = require('vm');

let fail = 0;
const bad = (m) => { console.log('FAIL: ' + m); fail++; };

// --- normalizeConfig, out of the shipped file -------------------------------
const sb = {
    window: { addEventListener() {}, dispatchEvent() {} },
    document: { createElement: () => ({ getContext: () => null }), addEventListener() {} },
    console, performance: { now: () => 0 }, navigator: {},
};
sb.window.window = sb.window; sb.self = sb.window;
vm.createContext(sb);
vm.runInContext(fs.readFileSync('src/core/objstate.js', 'utf8'), sb, { filename: 'objstate' });
vm.runInContext(fs.readFileSync('src/core/mol.js', 'utf8'), sb, { filename: 'mol' });
if (typeof sb.normalizeConfig !== 'function') {
    bad('core/mol.js no longer exposes normalizeConfig at module scope');
    process.exit(1);
}

// --- what viewer.py actually writes ----------------------------------------
const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
const section = (name) => {
    const keys = new Set();
    const re = new RegExp('config\\["' + name + '"\\]\\["(\\w+)"\\]\\s*=', 'g');
    let m;
    while ((m = re.exec(py)) !== null) keys.add(m[1]);
    return [...keys];
};
const RENDERING = section('rendering');
const DISPLAY = section('display');

if (RENDERING.length < 15) {
    bad(`only ${RENDERING.length} rendering keys found in viewer.py - the scan`
        + ' has stopped matching _nest_config and this test proves nothing');
}

// A value that cannot be confused with a default: no default in either file is
// a string starting with this, so "it came back" and "it was replaced by the
// default" can never look the same.
const MARK = '__probe__';
// ...except the enumerated ones, where an arbitrary string is not a value the
// key can hold. `style` is validated now (it names a look from a flat list) and
// an unknown name falls back to the default, which is right - but a sentinel
// would read as "the key was dropped".
const ENUM_PROBE = { style: 'ribbon', preset: 'ribbon' };
const probeFor = (key) => {
    if (ENUM_PROBE[key]) return ENUM_PROBE[key];
    // ...typed, because normalizeConfig coerces some keys and a string would
    // survive a check that a boolean would not. gpu in particular is read as
    // `=== true`, so it MUST arrive as a real boolean.
    if (key === 'gpu' || key === 'shadow' || key === 'smooth' || key === 'arrows'
        || key === 'base_plates' || key === 'detect_cyclic' || key === 'sheet_flat'
        || key === 'pencil') return true;
    if (key === 'detail') return 7;
    if (key === 'ortho' || key === 'shadow_strength' || key === 'fade'
        || key === 'thickness' || key === 'highlight' || key === 'outline_tint'
        || key === 'width' || key === 'shade') return 0.375;
    return MARK + key;
};

console.log(`viewer.py writes ${RENDERING.length} rendering keys`
    + ` and ${DISPLAY.length} display keys`);

for (const key of RENDERING.sort()) {
    // ...`style` is checked separately below, because it is the one key that
    // legitimately comes out as something else: it names a look from a flat
    // list, and normalizeConfig turns that name into a (style, preset) pair.
    if (key === 'style') continue;
    const want = probeFor(key);
    const got = sb.normalizeConfig({ rendering: { [key]: want } }).rendering[key];
    if (got !== want) {
        bad(`rendering.${key} = ${JSON.stringify(want)} came back as`
            + ` ${JSON.stringify(got)} - viewer.py sets it and normalizeConfig`
            + ' drops it, so the flag does nothing');
    }
}
for (const key of DISPLAY.sort()) {
    const want = key === 'size' ? [123, 456] : probeFor(key);
    const got = sb.normalizeConfig({ display: { [key]: want } }).display[key];
    const same = Array.isArray(want) ? JSON.stringify(got) === JSON.stringify(want) : got === want;
    if (!same) {
        bad(`display.${key} = ${JSON.stringify(want)} came back as ${JSON.stringify(got)}`);
    }
}

// --- normalizeConfig still CARRIES gpu, for the one build that has a choice --
// The website ships both painters and a toggle; index.html seeds it from the
// config. So the key survives normalization even though no public API sets it,
// and the two spellings still have to arrive as a real boolean.

// The constructor does `this.useGPU = config.rendering?.gpu === true`, so a
// truthy string or a 1 would read as false. Both the nested spelling Python
// uses and the flat one a web caller might use have to arrive as `true`.
for (const raw of [{ rendering: { gpu: true } }, { gpu: true }]) {
    const out = sb.normalizeConfig(raw);
    if (out.rendering.gpu !== true) {
        bad(`normalizeConfig(${JSON.stringify(raw)}) gives rendering.gpu =`
            + ` ${JSON.stringify(out.rendering.gpu)} - the renderer tests`
            + ' `=== true`, so the GPU stays off');
    }
}
// ...and absent means off, because a build with no WebGL2 painter must be
// asked for the GPU deliberately rather than get it by accident.
if (sb.normalizeConfig({}).rendering.gpu !== false) {
    bad('an empty config does not give rendering.gpu === false');
}
if (sb.normalizeConfig({ gpu: false }).rendering.gpu !== false) {
    bad('gpu:false does not survive as false');
}

// --- ONE FLAT LIST OF STYLE NAMES, and what each stands for -----------------
// The API takes a single name; inside it is still a (style, preset) pair. This
// is the translation, and getting it wrong is silent: the viewer draws A
// perfectly good cartoon, just not the one that was asked for.
const STYLE_MAP = {
    tube: ['tube', undefined],
    cartoon: ['cartoon', 'richardson'],
    richardson: ['cartoon', 'richardson'],
    ribbon: ['cartoon', 'ribbon'],
    '3d': ['cartoon', '3d'],
};
for (const [name, [wantStyle, wantPreset]] of Object.entries(STYLE_MAP)) {
    const out = sb.normalizeConfig({ style: name });
    if (out.rendering.style !== wantStyle) {
        bad(`style ${JSON.stringify(name)} gives rendering.style`
            + ` ${JSON.stringify(out.rendering.style)}, expected ${wantStyle}`);
    }
    if (out.rendering.preset !== wantPreset) {
        bad(`style ${JSON.stringify(name)} gives rendering.preset`
            + ` ${JSON.stringify(out.rendering.preset)}, expected`
            + ` ${JSON.stringify(wantPreset)}`);
    }
}
// ...a named preset still wins over what the style name implies
const both = sb.normalizeConfig({ style: 'richardson', preset: 'ribbon' });
if (both.rendering.preset !== 'ribbon') {
    bad(`style:'richardson' with preset:'ribbon' gives preset`
        + ` ${JSON.stringify(both.rendering.preset)} - an explicit preset must win`);
}
// ...and a name that is not a look falls back rather than being carried
if (sb.normalizeConfig({ style: 'wibble' }).rendering.style !== 'tube') {
    bad('an unknown style name is not falling back to the default');
}

// --- gpu PICKS THE BUNDLE, IT DOES NOT SWITCH A MODE ------------------------
// Each build ships ONE painter, so nothing can choose at runtime and a flag
// claiming to would be lying - which the old one did: normalizeConfig dropped
// the key, so py2Dmol.view(gpu=True) never reached the renderer.
//
// The notebook has two bundles now rather than one setting, and `gpu` decides
// which is written into the cell: WebGL2, or the 2D painter for a machine
// without it and for anyone wanting an SVG out of a notebook. So this asserts
// the opposite of what it used to, while the invariant underneath - one
// painter per bundle - is unchanged and checked by tests/bundles.js.
const sig = /class view:[\s\S]*?\n    \):/.exec(py);
if (!sig) {
    bad('could not find class view\'s __init__ signature in viewer.py');
} else if (!/\bgpu\s*=\s*True\b/.test(sig[0])) {
    bad('viewer.py view() has no gpu argument - it chooses which notebook'
        + ' bundle is inlined, and defaults to the GPU one');
}
if (!/config\["rendering"\]\["gpu"\]/.test(py)) {
    bad('viewer.py does not carry gpu into the config, so the bundle choice'
        + ' cannot read it');
}
if (!/notebook\.cpu\.min\.js/.test(py)) {
    bad('viewer.py never names the CPU bundle, so gpu=False sets a key and'
        + ' changes nothing');
}

console.log(fail ? `${fail} problems` : 'ok');
process.exit(fail ? 1 : 0);
