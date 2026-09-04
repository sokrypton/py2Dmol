/**
 * Which frame's map the panel shows, when the drawn frame has none of its own.
 *
 * 🔴 THE RULE IS "NEAREST BEHIND", AND A CACHE ONCE BROKE IT. resolveMapFrame
 * remembers the last index its backward scan landed on, and returning that
 * index straight out skips every frame BETWEEN it and the one being drawn - so
 * once the cache held frame 0, a frame with no map resolved to the FIRST map in
 * the trajectory rather than the one just behind it.
 *
 * A host that attaches a map just after adding its frame - which is what
 * computing one off the critical path means - lands in that window on every
 * single frame: the panel jumps back to the original map and snaps forward
 * when the real one arrives. It reads as a flicker; it is a wrong answer.
 *
 * The function is lifted out of the panel rather than loaded with it, because
 * it needs no DOM, no canvas and no renderer - only frames and a key.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'panels', 'heatmap.js');
const src = fs.readFileSync(file, 'utf8');
const body = src.slice(src.indexOf('resolveMapFrame: function'));
const source = body.slice(body.indexOf('{') + 1, body.indexOf('\n    },'));
if (!source.includes('frames')) {
    console.log('FAIL: could not lift resolveMapFrame out of the panel');
    process.exit(1);
}
const Heatmap = { mapsOfFrame: (f) => f.maps || {} };
Heatmap.resolveMapFrame = new Function('object', 'frameIndex', 'key', source)
    .bind(Heatmap);

// A live fold: each frame is added first and its map filled in a moment later.
const maps = [{ data: 0 }, { data: 1 }, { data: 2 }];
const object = { frames: [] };
const shown = [];
for (let i = 0; i < maps.length; i += 1) {
    object.frames.push({ name: `f${i}` });
    const before = Heatmap.resolveMapFrame(object, i, 'contact');
    shown.push(before ? before.maps.contact.data : null);
    object.frames[i].maps = { contact: maps[i] };
    const after = Heatmap.resolveMapFrame(object, i, 'contact');
    assert.equal(after && after.maps.contact, maps[i],
        `frame ${i} must show its own map once it has one`);
}
assert.deepEqual(shown, [null, 0, 1],
    `a frame with no map takes the one just behind it, not the first: ${shown}`);

// Nothing behind it at all is null rather than an older object's map.
assert.equal(Heatmap.resolveMapFrame({ frames: [{ name: 'x' }] }, 0, 'contact'), null);

// Out of range is null, not a throw: callers step past the end during a reload.
assert.equal(Heatmap.resolveMapFrame(object, 99, 'contact'), null);
assert.equal(Heatmap.resolveMapFrame(object, -1, 'contact'), null);

console.log('heatmap_resolve: ok', shown);
