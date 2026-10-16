// box: draws an axis-aligned wireframe box per payload {min: [x,y,z], max: [x,y,z]}.
// Model-space coordinates (the structure file's own Angstrom), 12 edges each.
// Registers whether this script runs before or after the py2Dmol library.
(function () {
  var P = window.py2dmolPlugins = window.py2dmolPlugins || {list: [], pending: []};

  function corners(b) {
    var out = [];
    for (var i = 0; i < 8; i++) {
      out.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
    }
    return out;
  }
  // the 12 edges of a cube as pairs of corner indices (corners differ in one bit)
  var EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  var def = {
    name: "box",
    version: "1",
    apiVersion: 1,
    options: {color: "#d81b60", width: 0.3},

    // Anything that changes what prims() emits. The GPU rebuilds its mesh only when this moves.
    key: function (ctx) {
      return JSON.stringify([ctx.payloads.map(function (p) { return p.payload; }), ctx.options]);
    },

    // Joins fit-to-view: the union of every box, in model space.
    bounds: function (ctx) {
      if (!ctx.payloads.length) return null;
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      ctx.payloads.forEach(function (p) {
        for (var k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p.payload.min[k]);
          hi[k] = Math.max(hi[k], p.payload.max[k]);
        }
      });
      return {min: lo, max: hi};
    },

    prims: function (ctx) {
      var style = {color: ctx.options.color, width: ctx.options.width};
      ctx.payloads.forEach(function (p) {
        var c = corners(p.payload);
        EDGES.forEach(function (e) { ctx.line(c[e[0]], c[e[1]], style); });
      });
    }
  };

  if (P.register) P.register(def); else P.pending.push(def);
})();
