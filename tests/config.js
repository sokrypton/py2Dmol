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

// --- PYTHON MUST NOT HOLD ITS OWN COPY OF THE PRESET NUMBERS ---------------
//
// LOOK_DEFAULTS in cartoon/geom.js is the table a preset means. viewer.py
// substitutes some of the same values when the caller leaves them unset -
// thickness, outline_tint, highlight and so on - and a CONFIG VALUE WINS over
// the table in the constructor, so anything Python names beats it.
//
// width was 2.0 there against PRESET_WIDTH of 3.0 here, under a comment in
// geom.js saying the width is "the same in all three". So a viewer BUILT as
// richardson drew a thinner ribbon than one SWITCHED to richardson, which is
// exactly the pair core/mol.js had already been fixed for once - the note
// above _look records width being 2.0 in one place and 3.0 in the other.
//
// So: every number viewer.py substitutes for a preset has to equal the table's,
// or not be substituted at all.
{
    // geom.js announces itself on load, and this sandbox has no Event
    // constructor - it is a config test, not a page.
    if (typeof sb.Event !== 'function') {
        sb.Event = function Event(t) { this.type = t; };
    }
    const geom = fs.readFileSync('src/cartoon/geom.js', 'utf8');
    vm.runInContext(geom, sb, { filename: 'geom' });
    const LOOK = sb.window.py2dmolCartoon && sb.window.py2dmolCartoon.LOOK_DEFAULTS;
    if (!LOOK || !LOOK.richardson) {
        bad('cartoon/geom.js no longer publishes LOOK_DEFAULTS - the preset'
            + ' numbers cannot be compared against viewer.py at all');
    } else {
        // viewer.py writes `if x is None: x = A if preset == "richardson" else B`
        const PY_TO_LOOK = {
            thickness: 'thickness', outline_tint: 'outlineTint',
            highlight: 'highlight', width: 'width', sheet_flat: 'sheetFlat',
            pencil: 'pencil', fade: 'fade', detail: 'detail',
        };
        let checked = 0;
        for (const [pyName, lookName] of Object.entries(PY_TO_LOOK)) {
            const re = new RegExp('if ' + pyName + ' is None:\\s*\\n\\s*'
                + pyName + ' = ([0-9.]+) if preset == "richardson"');
            const m = re.exec(py);
            if (!m) continue;                 // not substituted: the table wins
            checked++;
            const mine = Number(m[1]);
            const theirs = LOOK.richardson[lookName];
            if (typeof theirs === 'number' && Math.abs(mine - theirs) > 1e-9) {
                bad(`viewer.py substitutes ${pyName}=${mine} for richardson and`
                    + ` LOOK_DEFAULTS says ${theirs} - a config value beats the`
                    + ' table, so a viewer built as richardson draws differently'
                    + ' from one switched to it');
            }
        }
        console.log(`preset numbers: ${checked} of viewer.py's substitutions`
            + ' match LOOK_DEFAULTS');
    }
}

// --- THE TWO HALVES OF THE FRAME FIELD LIST HAVE TO NAME THE SAME THINGS ----
//
// viewer.py builds each frame of the static payload from FRAME_INHERITED and
// FRAME_ALWAYS; parts/ui.js takes it apart again with STATIC_FRAME_FIELDS.
// They were two hand-written runs of `if`s, and they disagreed three times
// over - `align`, `allow_reflection`, `position_atoms` and `position_elements`
// were each sent by one side and dropped by the other. Nothing failed: a
// trajectory simply did not superpose, and element colouring simply did not
// colour, on the notebook path alone.
//
// So this reads BOTH lists out of the source and compares them. A field added
// to one and not the other fails here, in the node lane, in seconds.
{
    const uiSrc = fs.readFileSync('src/parts/ui.js', 'utf8');
    const block = /const STATIC_FRAME_FIELDS = \[([\s\S]*?)\];/.exec(uiSrc);
    if (!block) {
        bad('src/parts/ui.js no longer declares STATIC_FRAME_FIELDS - the static'
            + ' loader has gone back to naming its fields one at a time, which'
            + ' is the shape that lost three of them');
    } else {
        const js = new Set([...block[1].matchAll(/\['(\w+)'/g)].map((m) => m[1]));
        const pyList = (name) => {
            const m = new RegExp(name
                + '\\s*=\\s*(?:frozenset\\()?[({]([\\s\\S]*?)[)}]').exec(py);
            return m ? [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]) : null;
        };
        const inherited = pyList('FRAME_INHERITED');
        const always = pyList('FRAME_ALWAYS');
        if (!inherited || !always) {
            bad('viewer.py no longer declares FRAME_INHERITED / FRAME_ALWAYS');
        } else {
            const pySet = new Set([...inherited, ...always]);
            const missingInJs = [...pySet].filter((k) => !js.has(k));
            const extraInJs = [...js].filter((k) => !pySet.has(k));
            if (missingInJs.length) {
                bad(`viewer.py sends ${missingInJs.join(', ')} and parts/ui.js`
                    + ' does not unpack it - the field reaches the page and is'
                    + ' thrown away, which is how align and the per-atom columns'
                    + ' were lost');
            }
            if (extraInJs.length) {
                bad(`parts/ui.js unpacks ${extraInJs.join(', ')} and viewer.py`
                    + ' never sends it');
            }
            console.log(`frame fields: ${pySet.size} named on both sides`);
            if (pySet.size < 10) {
                bad(`only ${pySet.size} fields found - the scan has stopped`
                    + ' matching and this check proves nothing');
            }
        }
    }
}

// --- THE SLAB IS THE VIEWER'S, and it rides top-level -----------------------
// clip is not a rendering key: it belongs to the camera, survives switching
// objects, and is a SELECTOR rather than a setting. It reaches the page as an
// unknown top-level key, which normalizeConfig carries through untouched by its
// carry-over loop - the same loop that cannot save `rendering.gpu`, because
// `rendering` is in knownKeys and a bare `clip` is not.
{
    const sel = { object: 'm', positions: [0, 1, 2] };
    const out = sb.normalizeConfig({ clip: sel });
    if (JSON.stringify(out.clip) !== JSON.stringify(sel)) {
        bad(`normalizeConfig dropped clip: ${JSON.stringify(out.clip)} - the`
            + ' notebook asks for its slab through the config, so this is the'
            + ' whole of view.clip() on the static path');
    }
    if (sb.normalizeConfig({}).clip !== undefined) {
        bad('an empty config invents a clip');
    }
}
// --- SHARING IS NOT A SETTING -----------------------------------------------
// It happens where Python can ASK THE PAGE whether anything is lending, and
// not where it cannot. A flag would be a way to choose the wrong one: forced
// on where nothing can be asked costs a viewer, forced off costs a bigger
// notebook and nothing else. It was a bool, then "auto"|bool, and is now
// neither - the decision reads _can_ask_the_page and nothing else.
const viewSig = (/class view:[\s\S]*?\n    \):/.exec(py) || [''])[0];
if (/share_library\s*=/.test(viewSig)) {
    bad('view() takes a share_library argument again - the decision belongs to'
        + ' _can_ask_the_page, because either forced answer is a way to be'
        + ' wrong about what the page actually has');
}
if (!/def _can_ask_the_page\(/.test(py)) {
    bad('viewer.py has no _can_ask_the_page - it is the whole of the condition');
}
if (!/self\._share_library = _can_ask_the_page\(\)/.test(py)) {
    bad('the sharing decision no longer comes from _can_ask_the_page');
}
if (!/def clip\(/.test(py)) {
    bad('viewer.py has no clip() - parts/clip.js is in every bundle and the'
        + ' notebook could not reach it');
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

// --- gpu IS A RUNTIME SETTING AGAIN ------------------------------------------
//
// It has been both. Originally a flag that normalizeConfig dropped, so
// py2Dmol.view(gpu=True) never turned anything on. Then a choice of FILE: one
// painter per bundle, because the library is inlined into the .ipynb once per
// show() cell and a second painter was 26 KB paid for every viewer.
//
// Sharing pays the library once for the document, so the notebook ships
// ONE bundle with both painters and the renderer decides at runtime - which is
// what core/mol.js does when both are loaded, taking config.rendering.gpu.
// The website has always worked this way.
const sig = /class view:[\s\S]*?\n    \):/.exec(py);
if (!sig) {
    bad('could not find class view\'s __init__ signature in viewer.py');
} else if (!/\bgpu\s*=\s*True\b/.test(sig[0])) {
    bad('viewer.py has no gpu argument');
}
if (!/config\["rendering"\]\["gpu"\]/.test(py)) {
    bad('viewer.py does not carry gpu into the config, so the renderer cannot'
        + ' read it - which is now the only way it has any effect');
}
// ...and there is exactly one notebook bundle to name.
if (/notebook\.(cpu|tube)\.min\.js/.test(py)) {
    bad('viewer.py still names a per-painter notebook bundle - there is one'
        + ' bundle now and gpu chooses a painter inside it, not a file');
}

console.log(fail ? `${fail} problems` : 'ok');
process.exit(fail ? 1 : 0);
