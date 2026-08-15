const { chromium } = require('playwright');

// WebGL2 painter: accumulates every quad into one interleaved buffer and draws
// it in ONE call, in submission order. No depth buffer needed - the quads are
// already depth-sorted by the renderer and a GPU rasterises primitives in order.
const GPU_SRC = `
window.makeGpuPainter = function (ctx2d, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const gl = cv.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
  if (!gl) return null;
  const vs = \`#version 300 es
  in vec2 aPos; in vec3 aCol; out vec3 vCol; uniform vec2 uRes;
  void main(){ vCol = aCol;
    vec2 p = (aPos / uRes) * 2.0 - 1.0; gl_Position = vec4(p.x, -p.y, 0.0, 1.0); }\`;
  const fs = \`#version 300 es
  precision mediump float; in vec3 vCol; out vec4 o;
  void main(){ o = vec4(vCol, 1.0); }\`;
  const mk = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const aPos = gl.getAttribLocation(prog, 'aPos'), aCol = gl.getAttribLocation(prog, 'aCol');
  gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 20, 8);
  gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);

  let data = new Float32Array(6 * 5 * 65536), used = 0;
  const colCache = new Map();
  const parse = (s) => {   // "rgb(r,g,b)" -> [r,g,b] floats, memoised
    let c = colCache.get(s);
    if (c) return c;
    let r = 0, g = 0, b = 0;
    if (typeof s === 'string' && s.charCodeAt(0) === 114) {
      let i = 4, v = 0, k = 0;
      for (; i < s.length; i++) { const ch = s.charCodeAt(i);
        if (ch >= 48 && ch <= 57) v = v * 10 + (ch - 48);
        else { if (k === 0) r = v; else if (k === 1) g = v; else b = v; k++; v = 0; if (k > 2) break; } }
      if (k === 2) b = v;
    }
    c = [r / 255, g / 255, b / 255];
    if (colCache.size < 40000) colCache.set(s, c);
    return c;
  };
  const push = (x, y, c) => { data[used++] = x; data[used++] = y;
    data[used++] = c[0]; data[used++] = c[1]; data[used++] = c[2]; };

  return {
    begin() { used = 0; },
    quad(x0, y0, x1, y1, x2, y2, x3, y3, fill) {
      if (used + 30 > data.length) { const d = new Float32Array(data.length * 2); d.set(data); data = d; }
      const c = parse(fill);
      push(x0, y0, c); push(x1, y1, c); push(x2, y2, c);
      push(x0, y0, c); push(x2, y2, c); push(x3, y3, c);
    },
    end() {
      gl.viewport(0, 0, w, h);
      gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, used), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, used / 5);
      ctx2d.drawImage(cv, 0, 0);
    },
    stats() { return { verts: used / 5, tris: used / 15, colours: colCache.size }; },
  };
};`;

(async () => {
  const b = await chromium.launch({ channel: 'chrome',
    args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewportSize: { width: 1000, height: 1000 } });
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('file:///Users/mini/Documents/GitHub/py2Dmol/tests/out/bench.html',
               { waitUntil:'domcontentloaded', timeout:180000 });
  await p.waitForFunction(() => window.py2dmol_viewers && Object.keys(window.py2dmol_viewers).length >= 8,
                          null, { timeout:120000 });
  await p.waitForTimeout(3000);
  await p.addScriptTag({ content: GPU_SRC });
  const res = await p.evaluate(() => {
    const out={};
    const med=a=>{a.sort((x,y)=>x-y);return +a[Math.floor(a.length/2)].toFixed(1);};
    const vs = Object.values(window.py2dmol_viewers).map(v=>v.renderer)
      .filter(r=>r.coords).sort((a,b)=>a.coords.length-b.coords.length);
    for (const r of vs) {
      const n = r.coords.length;
      if (n < 1000) continue;
      Object.assign(r,{style:'cartoon',cartoonDetail:0.5,cartoonThickness:0,cartoonCel:false,
                       outlineMode:'none', _quality:'perfect', cartoonPainter:null});
      for(let i=0;i<2;i++) r.render('w');
      const cpu=[]; for(let i=0;i<3;i++){const s=performance.now();r.render('b');cpu.push(performance.now()-s);}
      const ctx = r.canvas.getContext('2d');
      const gp = window.makeGpuPainter(ctx, r.canvas.width, r.canvas.height);
      if (!gp) { out[n]={error:'no webgl2'}; continue; }
      r.cartoonPainter = gp;
      for(let i=0;i<2;i++) r.render('w');
      const gpu=[]; for(let i=0;i<3;i++){const s=performance.now();r.render('b');gpu.push(performance.now()-s);}
      out[n]={ cpu: med(cpu), gpu: med(gpu), ...gp.stats() };
      r.cartoonPainter=null;
    }
    return out;
  });
  console.log('     n      CPU(ms)   GPU(ms)  speedup    triangles');
  Object.entries(res).forEach(([n,v])=>{
    if (v.error) { console.log(String(n).padStart(6)+'   '+v.error); return; }
    console.log(String(n).padStart(6)+String(v.cpu).padStart(13)+String(v.gpu).padStart(10)
      +((v.cpu/v.gpu).toFixed(1)+'x').padStart(9)+String(Math.round(v.tris)).padStart(13));
  });
  console.log('pageerrors:', errs.length?errs.slice(0,3):'none');
  await b.close();
})();
