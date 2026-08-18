// Comprehensive benchmark and regression tester for ribbon and side-chain paint ordering.
'use strict';
const fs = require('fs');
const path = require('path');

const W = 340, H = 270, SCALE = 27;
const radians = (d) => d * Math.PI / 180;
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a, b, t) => vadd(vmul(a, 1 - t), vmul(b, t));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const d = Math.hypot(a[0], a[1], a[2]) || 1; return vmul(a, 1 / d); };
const meanZ = (p) => p.reduce((s, q) => s + q[2], 0) / p.length;

function rotate(p, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x = cy * p[0] + sy * p[2];
  const z = -sy * p[0] + cy * p[2];
  return [x, cp * p[1] - sp * z, sp * p[1] + cp * z];
}

function alignToReportedView(p) {
  const yaw = radians(-19), pitch = radians(-75);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = p[0];
  const y1 = cp * p[1] + sp * p[2];
  const z1 = -sp * p[1] + cp * p[2];
  return [cy * x1 - sy * z1, y1, sy * x1 + cy * z1];
}

function station(theta, halfW, halfT) {
  const rise = 1.5 / radians(100);
  const c = [2.3 * Math.cos(theta), 2.3 * Math.sin(theta), rise * theta];
  const t = norm([-2.3 * Math.sin(theta), 2.3 * Math.cos(theta), rise]);
  const n = norm([Math.cos(theta), Math.sin(theta), 0]);
  const b = norm(cross(t, n));
  return {
    c, t, n, b,
    Lp: vadd(vadd(c, vmul(n, halfW)), vmul(b, halfT)),
    Lm: vadd(vadd(c, vmul(n, halfW)), vmul(b, -halfT)),
    Rp: vadd(vadd(c, vmul(n, -halfW)), vmul(b, halfT)),
    Rm: vadd(vadd(c, vmul(n, -halfW)), vmul(b, -halfT))
  };
}

function surface(name, pts, normal, piece) {
  return { name, pts, normal: norm(normal), piece, kind: 'rib' };
}

function makeGeometry(halfT, multiSidechain = false) {
  const pieces = [];
  let nextId = 1;
  const step = radians(25);
  const phase = radians(12);
  for (let i = -7; i < 8; i++) {
    const a = station(phase + i * step, 1.3, halfT);
    const b = station(phase + (i + 1) * step, 1.3, halfT);
    const n = norm(vadd(a.n, b.n));
    const bn = norm(vadd(a.b, b.b));
    const tn = norm(vadd(a.t, b.t));
    const surfaces = [
      surface('top', [a.Lp, b.Lp, b.Rp, a.Rp], bn, i),
      surface('bottom', [a.Lm, a.Rm, b.Rm, b.Lm], vmul(bn, -1), i),
      surface('left', [a.Lp, a.Lm, b.Lm, b.Lp], n, i),
      surface('right', [a.Rp, b.Rp, b.Rm, a.Rm], vmul(n, -1), i)
    ];
    if (i === -7) surfaces.push(surface('cap0', [a.Lp, a.Rp, a.Rm, a.Lm], vmul(tn, -1), i));
    if (i === 7) surfaces.push(surface('cap1', [b.Lp, b.Lm, b.Rm, b.Rp], tn, i));
    for (const s of surfaces) s.id = nextId++;
    const all = [a.Lp, a.Lm, a.Rp, a.Rm, b.Lp, b.Lm, b.Rp, b.Rm];
    pieces.push({ id: i, surfaces, centroidZ: meanZ(all) });
  }

  const sticks = [];
  const stickRoots = multiSidechain 
    ? Array.from({ length: 15 }, (_, i) => phase + (i - 7) * step + step * 0.35)
    : [phase + step * 0.35];

  for (const thetaProbe of stickRoots) {
    const root = station(thetaProbe, 1.3, halfT);
    const dir = norm([-Math.sin(thetaProbe), Math.cos(thetaProbe), 0]);
    const start = [root.c[0], root.c[1], root.c[2] + halfT * 0.12];
    const end = vadd(start, vmul(dir, 3.8));
    const u = norm([Math.cos(thetaProbe), Math.sin(thetaProbe), 0]);
    const v = [0, 0, 1];
    const r = 0.25;
    const ring = (c) => [
      vadd(vadd(c, vmul(u, r)), vmul(v, r)),
      vadd(vadd(c, vmul(u, -r)), vmul(v, r)),
      vadd(vadd(c, vmul(u, -r)), vmul(v, -r)),
      vadd(vadd(c, vmul(u, r)), vmul(v, -r))
    ];
    const q0 = ring(start), q1 = ring(end);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      const pts = [q0[k], q0[j], q1[j], q1[k]];
      const normal = norm(cross(vsub(q1[k], q0[k]), vsub(q0[j], q0[k])));
      sticks.push({ name: 'stick', id: nextId++, pts, normal, kind: 'stick', stickSide: true });
    }
    sticks.push({ name: 'stick', id: nextId++, pts: [...q1].reverse(), normal: dir, kind: 'stick' });
  }
  return { pieces, stick: sticks };
}

function transformGeometry(geom, yawDeg, pitchDeg, cullEps = 0.12) {
  const yaw = radians(yawDeg), pitch = radians(pitchDeg);
  const transformSurface = (s) => {
    const pts = s.pts.map((p) => rotate(alignToReportedView(p), yaw, pitch));
    const normal = rotate(alignToReportedView(s.normal), yaw, pitch);
    return { ...s, pts, normal, z: meanZ(pts), facing: normal[2] };
  };
  const pieces = geom.pieces.map((p) => {
    const surfaces = p.surfaces.map(transformSurface);
    const points = surfaces.flatMap((s) => s.pts);
    return { ...p, surfaces, z: meanZ(points) };
  });
  return {
    pieces,
    stick: geom.stick.map(transformSurface)
  };
}

function projected(s) {
  return { ...s, pts: s.pts.map((p) => [W / 2 + p[0] * SCALE, H / 2 - p[1] * SCALE, p[2]]) };
}

function triangles(s) {
  const p = projected(s).pts;
  if (p.length === 4) return [[p[0], p[1], p[2]], [p[0], p[2], p[3]]];
  const out = [];
  for (let i = 1; i + 1 < p.length; i++) out.push([p[0], p[i], p[i + 1]]);
  return out;
}

function rasterTriangle(tri, visit) {
  const [a, b, c] = tri;
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-7) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
    const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 >= -1e-7 && w1 >= -1e-7 && w2 >= -1e-7) visit(x, y, w0 * a[2] + w1 * b[2] + w2 * c[2]);
  }
}

function referenceBuffers(g) {
  const depth = new Float64Array(W * H); depth.fill(-Infinity);
  const ids = new Uint8Array(W * H);
  const kinds = new Uint8Array(W * H); // 1 = rib, 2 = stick
  const all = g.pieces.flatMap((p) => p.surfaces).concat(g.stick);
  for (const s of all) {
    const kindId = s.kind === 'stick' ? 2 : 1;
    for (const tri of triangles(s)) rasterTriangle(tri, (x, y, z) => {
      const k = y * W + x;
      if (z > depth[k]) { depth[k] = z; ids[k] = s.id; kinds[k] = kindId; }
    });
  }
  return { depth, ids, kinds };
}

function splitBroadSurface(s, count) {
  if (s.kind !== 'rib' || (s.name !== 'top' && s.name !== 'bottom')) return [s];
  let aL, aR, bL, bR;
  if (s.name === 'top') {
    [aL, bL, bR, aR] = s.pts;
  } else {
    [aL, aR, bR, bL] = s.pts;
  }
  const result = [];
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1) / count;
    const pts = [lerp(aL, aR, t0), lerp(bL, bR, t0), lerp(bL, bR, t1), lerp(aL, aR, t1)];
    result.push({ ...s, pts, z: meanZ(pts), tile: i });
  }
  return result;
}

function splitStickSurface(s, count) {
  if (!s.stickSide || count <= 1) return [s];
  const [a0, b0, b1, a1] = s.pts;
  const result = [];
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1) / count;
    const pts = [lerp(a0, a1, t0), lerp(b0, b1, t0), lerp(b0, b1, t1), lerp(a0, a1, t1)];
    result.push({ ...s, pts, z: meanZ(pts), stickTile: i });
  }
  return result;
}

function orderedSurfaces(g, mode, ribTiles = 2, stickTiles = 2, cullEps = 0.12) {
  const visible = (s) => s.facing > -cullEps;
  const stick = (stickTiles > 1 ? g.stick.flatMap((s) => splitStickSurface(s, stickTiles)) : g.stick).filter(visible);
  
  if (mode === 'body') {
    const prims = g.pieces.map((p) => ({ kind: 'body', z: p.z, surfaces: p.surfaces.filter(visible) }))
      .concat(stick.map((s) => ({ kind: 'surface', z: s.z, surface: s })));
    prims.sort((a, b) => a.z - b.z);
    const result = [];
    for (const p of prims) {
      if (p.kind === 'surface') result.push(p.surface);
      else result.push(...p.surfaces.sort((a, b) => a.facing - b.facing));
    }
    return result;
  }
  
  if (mode === 'surface') {
    const surfaces = g.pieces.flatMap((p) => p.surfaces).filter(visible).concat(stick);
    return surfaces.sort((a, b) => a.z - b.z);
  }

  if (mode === 'near_far') {
    const prims = [];
    for (const p of g.pieces) {
      const vis = p.surfaces.filter(visible);
      const near = vis.filter((s) => s.facing >= 0);
      const far = vis.filter((s) => s.facing < 0);
      near.sort((a, b) => a.facing - b.facing);
      far.sort((a, b) => a.facing - b.facing);
      if (far.length) prims.push({ kind: 'group', z: meanZ(far.flatMap((s) => s.pts)), surfaces: far });
      if (near.length) prims.push({ kind: 'group', z: meanZ(near.flatMap((s) => s.pts)), surfaces: near });
    }
    prims.push(...stick.map((s) => ({ kind: 'surface', z: s.z, surfaces: [s] })));
    prims.sort((a, b) => a.z - b.z);
    return prims.flatMap((p) => p.surfaces);
  }

  if (mode === 'tiles') {
    let rib = g.pieces.flatMap((p) => p.surfaces).filter(visible);
    if (ribTiles > 1) {
      rib = rib.flatMap((s) => splitBroadSurface(s, ribTiles));
    }
    const all = rib.concat(stick);
    return all.sort((a, b) => a.z - b.z);
  }

  throw new Error('Unknown mode: ' + mode);
}

function painterBuffers(g, mode, ribTiles = 2, stickTiles = 2, cullEps = 0.12) {
  const ids = new Uint8Array(W * H);
  const kinds = new Uint8Array(W * H); // 1 = rib, 2 = stick
  for (const s of orderedSurfaces(g, mode, ribTiles, stickTiles, cullEps)) {
    const kindId = s.kind === 'stick' ? 2 : 1;
    for (const tri of triangles(s)) {
      rasterTriangle(tri, (x, y) => {
        const k = y * W + x;
        ids[k] = s.id;
        kinds[k] = kindId;
      });
    }
  }
  return { ids, kinds };
}

function evaluateMismatch(painter, ref) {
  let wrong = 0, chainOverRib = 0, ribOverChain = 0, ribOverRib = 0;
  for (let k = 0; k < painter.ids.length; k++) {
    if (ref.ids[k] && painter.ids[k] !== ref.ids[k]) {
      wrong++;
      const drawnKind = painter.kinds[k];
      const trueKind = ref.kinds[k];
      if (drawnKind === 2 && trueKind === 1) chainOverRib++;
      else if (drawnKind === 1 && trueKind === 2) ribOverChain++;
      else if (drawnKind === 1 && trueKind === 1) ribOverRib++;
    }
  }
  return { wrong, chainOverRib, ribOverChain, ribOverRib };
}

function runBenchmark() {
  console.log('=== BENCHMARK: Ribbon vs Side-Chain Paint Order ===\n');

  const modes = [
    { name: '1. Centroid (Shipped)', mode: 'body', rTiles: 1, sTiles: 1 },
    { name: '2. Near/Far Split (Att. 3.4)', mode: 'near_far', rTiles: 1, sTiles: 1 },
    { name: '3. Per-Surface (Att. 3.3)', mode: 'surface', rTiles: 1, sTiles: 1 },
    { name: '4. Width Tiling R2 S1', mode: 'tiles', rTiles: 2, sTiles: 1 },
    { name: '5. Width Tiling R2 S2', mode: 'tiles', rTiles: 2, sTiles: 2 },
    { name: '6. Width Tiling R4 S2', mode: 'tiles', rTiles: 4, sTiles: 2 },
    { name: '7. Width Tiling R4 S4', mode: 'tiles', rTiles: 4, sTiles: 4 },
  ];

  // A. REPORTED VIEW (Yaw -19, Pitch -75)
  console.log('--- A. Reported View (Yaw -19°, Pitch -75°, Single Diagnostic Side-chain) ---');
  const geomSingle = makeGeometry(0.38, false);
  const gRep = transformGeometry(geomSingle, -19, -75);
  const refRep = referenceBuffers(gRep);

  for (const m of modes) {
    const p = painterBuffers(gRep, m.mode, m.rTiles, m.sTiles);
    const res = evaluateMismatch(p, refRep);
    console.log(`${m.name.padEnd(32)}: total = ${String(res.wrong).padStart(4)} px | chain>rib = ${String(res.chainOverRib).padStart(3)} | rib>chain = ${String(res.ribOverChain).padStart(3)} | rib>rib = ${String(res.ribOverRib).padStart(3)}`);
  }

  // B. 200 VIEW SPHERE SCAN (Single Side-chain)
  console.log('\n--- B. 200-View Spherical Scan (Single Side-chain) ---');
  const N = 200;
  for (const m of modes) {
    let totWrong = 0, totCR = 0, totRC = 0, totRR = 0;
    for (let i = 0; i < N; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / N);
      const theta = Math.PI * (1 + 5**0.5) * i;
      const yaw = (theta * 180 / Math.PI) % 360 - 180;
      const pitch = (phi - Math.PI / 2) * 180 / Math.PI;
      const g = transformGeometry(geomSingle, yaw, pitch);
      const ref = referenceBuffers(g);
      const p = painterBuffers(g, m.mode, m.rTiles, m.sTiles);
      const res = evaluateMismatch(p, ref);
      totWrong += res.wrong;
      totCR += res.chainOverRib;
      totRC += res.ribOverChain;
      totRR += res.ribOverRib;
    }
    console.log(`${m.name.padEnd(32)}: total = ${String(totWrong).padStart(6)} px | chain>rib = ${String(totCR).padStart(5)} | rib>chain = ${String(totRC).padStart(5)} | rib>rib = ${String(totRR).padStart(5)}`);
  }

  // C. 200 VIEW SPHERE SCAN (Multi-Residue Side-chains on Every Residue)
  console.log('\n--- C. 200-View Spherical Scan (Multi-Residue: Side-chain on EVERY Residue) ---');
  const geomMulti = makeGeometry(0.38, true);
  for (const m of modes) {
    let totWrong = 0, totCR = 0, totRC = 0, totRR = 0;
    for (let i = 0; i < N; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / N);
      const theta = Math.PI * (1 + 5**0.5) * i;
      const yaw = (theta * 180 / Math.PI) % 360 - 180;
      const pitch = (phi - Math.PI / 2) * 180 / Math.PI;
      const g = transformGeometry(geomMulti, yaw, pitch);
      const ref = referenceBuffers(g);
      const p = painterBuffers(g, m.mode, m.rTiles, m.sTiles);
      const res = evaluateMismatch(p, ref);
      totWrong += res.wrong;
      totCR += res.chainOverRib;
      totRC += res.ribOverChain;
      totRR += res.ribOverRib;
    }
    console.log(`${m.name.padEnd(32)}: total = ${String(totWrong).padStart(6)} px | chain>rib = ${String(totCR).padStart(5)} | rib>chain = ${String(totRC).padStart(5)} | rib>rib = ${String(totRR).padStart(5)}`);
  }
}

runBenchmark();
