/* Paint-order audit, written once and plainly.
 *
 *   CARTOON=<path to viewer-cartoon.js> [SC_ALL=1] node audit.js
 *
 * Rasterises every face the painter emits. At each covered pixel it compares
 * the face that ENDS UP on top with the face that actually IS on top.
 *
 * THREE THINGS THIS GETS RIGHT THAT EARLIER VERSIONS DID NOT:
 *  - the painter's order INSIDE a rib prim (surfaces by facing, then stations
 *    in chain order); giving them all one order measures the harness instead
 *  - a CLIPPED stick face still counts toward the truth - it really is at that
 *    depth - while being excluded from what was painted, so erasing geometry
 *    that should have been visible scores as the error it is
 *  - each stick face is cut by ITS OWN prim's clipR, never by the union of
 *    every clip in the scene
 */
const fs = require('fs'), vm = require('vm');
const SRC = process.env.CARTOON;
const SC_ALL = !!process.env.SC_ALL;
const W = 900, H = 620;

const sb = { window: { addEventListener() {}, dispatchEvent() {} },
  document: { createElement: () => ({ getContext: () => null }) },
  console, performance: { now: () => Date.now() }, navigator: {}, Event: function () {} };
sb.window.window = sb.window; sb.self = sb.window; vm.createContext(sb);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sb, { filename: 'c' });
const cartoon = sb.window.py2dmolCartoon;

const mkCtx = () => { const noop = () => {}; const st = { d: 0 };
  return new Proxy({}, { get: (t, k) => {
    if (k === 'canvas') return { width: W, height: H };
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    if (k === 'save') return () => { st.d++; };
    if (k === 'restore') return () => { st.d--; };
    return typeof t[k] === 'function' ? t[k] : noop;
  }, set: () => true }); };

const R = 2.3, RISE = 1.5, DTH = 100 * Math.PI / 180, N = 9, OWNER = 4, BOND = 1.53;
const unit = (v) => { const L = Math.hypot(v[0], v[1], v[2]); return [v[0] / L, v[1] / L, v[2] / L]; };
function frame(u) {
  const th = u * DTH, c = Math.cos(th), s = Math.sin(th);
  const t = unit([-R * s * DTH, R * c * DTH, RISE]);
  const n = unit([-t[0] * t[2], -t[1] * t[2], 1 - t[2] * t[2]]);
  return { C: [R * c, R * s, RISE * u], t, n,
    b: [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]] };
}
function turn(p, yaw, pitch) {
  const x = p[0], y = p[1], z = p[2] - RISE * (N - 1) / 2;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return { x: x1, y: y * cp - z1 * sp, z: y * sp + z1 * cp };
}
function render(thick, tilt, yaw, pitch) {
  const coords = [], types = [], segs = [], sc = new Map();
  for (let i = 0; i < N; i++) { coords.push(frame(i).C); types.push('P'); }
  for (let j = 0; j + 1 < N; j++) segs.push({ type: 'P', idx1: j, idx2: j + 1, origIndex: j });
  const owners = SC_ALL ? Array.from({ length: N }, (_, i) => i) : [OWNER];
  for (const ow of owners) {
    const f = frame(ow), a = (tilt + (SC_ALL ? ow * 17 : 0)) * Math.PI / 180;
    const d = unit([Math.cos(a) * f.b[0] + Math.sin(a) * f.n[0],
      Math.cos(a) * f.b[1] + Math.sin(a) * f.n[1],
      Math.cos(a) * f.b[2] + Math.sin(a) * f.n[2]]);
    const i1 = coords.length;
    coords.push([f.C[0] + d[0] * BOND, f.C[1] + d[1] * BOND, f.C[2] + d[2] * BOND]);
    coords.push([f.C[0] + d[0] * 3.0, f.C[1] + d[1] * 3.0, f.C[2] + d[2] * 3.0]);
    types.push('L'); types.push('L');
    segs.push({ type: 'L', idx1: ow, idx2: i1, origIndex: ow });
    segs.push({ type: 'L', idx1: i1, idx2: i1 + 1, origIndex: i1 });
    sc.set(i1, { owner: ow }); sc.set(i1 + 1, { owner: ow });
  }
  const rot = coords.map((p) => turn(p, yaw, pitch));
  const n = rot.length;
  const r = { coords: rot, rotatedCoords: rot, segmentIndices: segs, positionTypes: types,
    positionNames: rot.map(() => 'ALA'),
    viewerState: { extent: 16, zoom: 1.6, ortho: 1, focalLength: 100 },
    objectsData: { obj: { maxExtent: 16 } }, currentObjectName: 'obj', currentFrame: 0,
    lineWidth: 3, visibilityMask: null, outlineMode: 'on', relativeOutlineWidth: 3,
    shadowEnabled: true, cartoonShade: 1, colorMode: 'chain', cartoonDetail: 4,
    cartoonThickness: thick, _thicknessUserSet: true, _forceSec: 'H'.repeat(N) + 'CC'.repeat(owners.length),
    sidechainMap: sc, overlayState: { enabled: false }, screenFrameId: 0,
    screenX: new Float64Array(n), screenY: new Float64Array(n),
    screenRadius: new Float64Array(n), screenValid: new Uint8Array(n),
    _calculateSegmentWidthMultiplier: () => 1, _primProbe: null };
  cartoon.render(r, mkCtx(), W, H, segs.map((s) => (s.type === 'L'
    ? { r: 200, g: 125, b: 30 } : { r: 94, g: 134, b: 174 })));
  return r._primProbe || [];
}
const ribQuads = (rp) => {
  const out = [], ns = rp.Lp.length;
  for (let k = 0; k + 1 < ns; k++) {
    for (const q of [[rp.Lp[k], rp.Rp[k], rp.Rp[k + 1], rp.Lp[k + 1]],
      [rp.Lm[k], rp.Rm[k], rp.Rm[k + 1], rp.Lm[k + 1]],
      [rp.Lp[k], rp.Lm[k], rp.Lm[k + 1], rp.Lp[k + 1]],
      [rp.Rp[k], rp.Rm[k], rp.Rm[k + 1], rp.Rp[k + 1]]]) {
      if (q.every(Boolean)) out.push(q);
    }
  }
  return out;
};
function collect(prims) {
  const faces = [];
  for (let o = 0; o < prims.length; o++) {
    const g = prims[o];
    if (g.kind === 'stickFace') {
      if (g.draw === false) continue;
      let cq = null;
      if (g.clipR) { cq = []; for (const rp of g.clipR) cq.push(...ribQuads(rp)); }
      faces.push({ q: g.q, order: o * 1e6, kind: 2, cq });
    } else if (g.kind === 'rib') {
      const n = g.Lp.length; let bS = 0, nS = 0;
      for (let k = 0; k < n; k++) { bS += g.oB[k]; nS += g.oN[k]; }
      const bA = bS / n, nA = nS / n;
      const surf = [
        { k: bA, f: (k) => [g.Lp[k], g.Rp[k], g.Rp[k + 1], g.Lp[k + 1]] },
        { k: -bA, f: (k) => [g.Lm[k], g.Rm[k], g.Rm[k + 1], g.Lm[k + 1]] },
        { k: nA, f: (k) => [g.Lp[k], g.Lm[k], g.Lm[k + 1], g.Lp[k + 1]] },
        { k: -nA, f: (k) => [g.Rp[k], g.Rm[k], g.Rm[k + 1], g.Rp[k + 1]] },
      ].sort((x, y) => x.k - y.k);
      for (let si = 0; si < 4; si++) {
        for (let k = 0; k + 1 < n; k++) {
          const q = surf[si].f(k);
          if (q.some((v) => !v)) continue;
          faces.push({ q, order: o * 1e6 + si * 1000 + k, kind: 1, cq: null });
        }
      }
    }
  }
  return faces;
}
const area = (q) => { let a = 0;
  for (let i = 0; i < 4; i++) { const u = q[i], v = q[(i + 1) % 4]; a += u[0] * v[1] - v[0] * u[1]; }
  return a / 2; };
const triZ = (p0, p1, p2, x, y) => {
  const d = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
  if (Math.abs(d) < 1e-9) return null;
  const a = ((p1[1] - p2[1]) * (x - p2[0]) + (p2[0] - p1[0]) * (y - p2[1])) / d;
  const b = ((p2[1] - p0[1]) * (x - p2[0]) + (p0[0] - p2[0]) * (y - p2[1])) / d;
  const c = 1 - a - b;
  if (a < -1e-9 || b < -1e-9 || c < -1e-9) return null;
  return a * p0[2] + b * p1[2] + c * p2[2]; };
const zAt = (q, x, y) => { const v = triZ(q[0], q[1], q[2], x, y);
  return v === null ? triZ(q[0], q[2], q[3], x, y) : v; };
const inQuad = (q, x, y) => { let hit = false;
  for (let i = 0, j = 3; i < 4; j = i++) { const a = q[i], b = q[j];
    if (((a[1] > y) !== (b[1] > y)) && (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) hit = !hit; }
  return hit; };
function audit(prims) {
  const F = collect(prims);
  const topO = new Float64Array(W * H).fill(-1), topZ = new Float64Array(W * H);
  const topK = new Uint8Array(W * H), bZ = new Float64Array(W * H).fill(-1e9), bK = new Uint8Array(W * H);
  for (const f of F) {
    if (area(f.q) <= 0) continue;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of f.q) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, Math.ceil(x1)); x++) {
        const z = zAt(f.q, x, y);
        if (z === null || z === undefined) continue;
        const i = y * W + x;
        let cut = false;
        if (f.cq) { for (const c of f.cq) if (inQuad(c, x, y)) { cut = true; break; } }
        if (!cut && f.order > topO[i]) { topO[i] = f.order; topZ[i] = z; topK[i] = f.kind; }
        if (z > bZ[i]) { bZ[i] = z; bK[i] = f.kind; }
      }
    }
  }
  let cov = 0, wrong = 0, so = 0, rs = 0, rr = 0, mx = 0;
  for (let i = 0; i < topO.length; i++) {
    if (topO[i] < 0) continue;
    cov++;
    const e = bZ[i] - topZ[i];
    if (e <= 1e-6) continue;
    wrong++; if (e > mx) mx = e;
    if (topK[i] === 2 && bK[i] === 1) so++;
    else if (topK[i] === 1 && bK[i] === 2) rs++;
    else if (topK[i] === 1 && bK[i] === 1) rr++;
  }
  return { cov, wrong, so, rs, rr, mx };
}
let tot = 0, so = 0, rs = 0, rr = 0, mx = 0, clean = 0;
const NV = 200;
for (let i = 0; i < NV; i++) {
  const ph = Math.acos(1 - 2 * (i + 0.5) / NV), th = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
  const a = audit(render(0.75, 60, th, ph - Math.PI / 2));
  tot += a.wrong; so += a.so; rs += a.rs; rr += a.rr; mx = Math.max(mx, a.mx);
  if (!a.wrong) clean++;
}
console.log(`wrong ${String(tot).padStart(6)}  chain>rib ${String(so).padStart(6)}`
  + `  rib>chain ${String(rs).padStart(6)}  rib>rib ${String(rr).padStart(6)}`
  + `  worst ${mx.toFixed(2)}  clean ${clean}/${NV}`);
