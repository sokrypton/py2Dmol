/* Side chains, end to end through the WEB APP's own chain:
 *
 *   node tests/sidechain_chain.js [structure.cif ...]
 *
 * parse -> convertParsedToFrameData -> app.js's frameObj copy ->
 * _materialiseSidechains. Every hop is real code, and the middle one is lifted
 * out of web/app.js as source text rather than reimplemented, because that hop
 * is exactly where this broke: frameObj is assembled field by field, so a field
 * nobody named is dropped in silence. Side chains were captured, stored, copied
 * past, and never reached the renderer - reported as "No side-chain atoms in
 * this structure" on 6MRR, which has 354 of them.
 *
 * Default corpus is whatever .cif files sit in the repo root.
 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=path.resolve(__dirname, '..');
const sb={window:{addEventListener(){},dispatchEvent(){}},document:{createElement:()=>({getContext:()=>null})},console,performance:{now:()=>Date.now()},navigator:{},Event:function(){}};
sb.window.window=sb.window; sb.self=sb.window; vm.createContext(sb);
vm.runInContext(fs.readFileSync(ROOT+'/py2Dmol/resources/viewer-cartoon.js','utf8'),sb,{filename:'c'});
vm.runInContext(fs.readFileSync(ROOT+'/web/utils.js','utf8'),sb,{filename:'u'});

// the frameObj literal, lifted straight out of app.js so this cannot drift
const app=fs.readFileSync(ROOT+'/web/app.js','utf8');
const i=app.indexOf('const frameObj = {');
const j=app.indexOf('};', i);
const lit=app.slice(i, j+2);
const mkFrameObj=new Function('frameData', lit+' return frameObj;');

// EVERY FRAME IS BUILT FIELD BY FIELD, and a field nobody names is dropped in
// silence. That has now happened twice: web/app.js's frameObj (side chains
// captured, stored, and never reaching the renderer) and viewer-mol.js's
// extractedFrame (a copied sub-structure with no side chains at all). Neither
// failed loudly - both just produced a structure that had none. So the literals
// themselves are checked, by name, and a rename fails the test rather than
// quietly stopping covering anything.
function checkFrameBuilders(){
  const builders=[
    ['web/app.js', 'const frameObj = {'],
    ['web/app.js', 'const resolvedFrame = {'],
    ['py2Dmol/resources/viewer-mol.js', 'const extractedFrame = {'],
  ];
  let bad=0;
  for(const [file,marker] of builders){
    const src=fs.readFileSync(path.join(ROOT,file),'utf8');
    const i=src.indexOf(marker);
    if(i<0){
      console.log(`FAIL ${file}: cannot find \`${marker}\` - it was renamed or removed,`
        +` so nothing here checks it any more`);
      bad++; continue;
    }
    let a=src.indexOf('{',i), d=0, k=a;
    for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
    const body=src.slice(a,k+1);
    if(!/\bsidechains\b/.test(body)){
      console.log(`FAIL ${file}: \`${marker}\` does not carry \`sidechains\` -`
        +` it will be dropped in silence`);
      bad++;
    }
  }
  if(!bad) console.log('PASS  every field-by-field frame builder carries sidechains');
  return bad;
}
// The tables are module-scope `const`, which - unlike a function declaration -
// never lands on the sandbox global, so they are lifted out of the source text.
// That also means this scores the SHIPPED table rather than a copy of it, which
// for a 20-entry connectivity table is the whole point: a copy would drift and
// then agree with itself.
const lifted=(()=>{
  const src=fs.readFileSync(path.join(ROOT,'web/utils.js'),'utf8');
  const grab=(nm)=>{
    const i=src.indexOf('const '+nm+' = ');
    if(i<0) throw new Error('not found in web/utils.js: '+nm);
    let a=src.indexOf('{',i), d=0, k=a;
    for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
    // eslint-disable-next-line no-eval
    return eval('('+src.slice(a,k+1)+')');
  };
  return { PROTEIN_SIDECHAIN_BONDS: grab('PROTEIN_SIDECHAIN_BONDS'),
           SIDECHAIN_ATOM_ALIASES: grab('SIDECHAIN_ATOM_ALIASES') };
})();

// THE ALIAS MAP NEEDS A FILE THAT USES THE OLD NAMES, and every structure here
// is modern mmCIF - so removing the ILE alias changed nothing and no check
// noticed. One is made by renaming, which is exactly the difference between a
// PDB v2 file and a v3 one: isoleucine's terminal carbon is CD in v2, CD1 in
// v3. Without the alias its bond to CG1 is never found, the atom detaches from
// the CA and is dropped, and the side chain loses its tip.
function checkAliases(){
  const src=fs.readFileSync(path.join(ROOT,'1UBQ.cif'),'utf8');
  const run=(text)=>{
    const p=sb.parseCIF(text);
    const m=Array.isArray(p)?p:(p.models||p.frames);
    const fd=sb.convertParsedToFrameData(Array.isArray(m[0])?m[0]:m);
    return fd.sidechains;
  };
  const v3=run(src);
  // ILE CD1 -> CD, on the atom-name columns only
  const v2text=src.split('\n').map((L)=>{
    if(!/^ATOM/.test(L)) return L;
    const t=L.split(/\s+/);
    if(t[5]!=='ILE') return L;
    return L.replace(/(\s)"?CD1"?(\s)/, '$1CD$2');
  }).join('\n');
  const v2=run(v2text);
  if(!v3||!v2){ console.log('FAIL alias: 1UBQ produced no side chains'); return 1; }
  if(v2.pos.length!==v3.pos.length){
    console.log(`FAIL alias: the v2-named copy kept ${v2.pos.length} atoms, `
      +`the v3 original ${v3.pos.length} - an isoleucine lost its tip`);
    return 1;
  }
  if(v2.bonds.length!==v3.bonds.length){
    console.log(`FAIL alias: ${v2.bonds.length/2} bonds against ${v3.bonds.length/2}`);
    return 1;
  }
  // and the rename must actually have happened, or this proves nothing
  if(!/\sCD\s/.test(v2text) || v2text===src){
    console.log('FAIL alias: the fixture was not renamed, so it tests nothing');
    return 1;
  }
  console.log(`PASS  PDB v2 atom names (ILE CD) give the same ${v2.pos.length} atoms`);
  return 0;
}

// THE PDB PATH, which nothing here reached: every structure in this repo is
// mmCIF, so the whole capture was only ever exercised through parseCIF. The
// same structure is written out as PDB and put through parsePDB, and the two
// side-chain tables must agree atom for atom and bond for bond.
//
// Written out TWICE, with and without the element column: columns 77-78 of an
// ATOM record are optional and older files leave them blank. That matters
// because hydrogens are then identified by name instead - and a residue not in
// the connectivity table, which falls back to distance bonding, kept HB2, HG
// and 1HB before that was handled.
function cifToPdb(text, withElement){
  const out=[]; const hdr=[]; let serial=1; let inLoop=false;
  for(const L of text.split('\n')){
    if(L.startsWith('_atom_site.')){hdr.push(L.trim()); inLoop=true; continue;}
    if(!inLoop || !/^(ATOM|HETATM)/.test(L)) continue;
    const t=L.trim().split(/\s+/);
    const g=(k)=>{const i=hdr.indexOf('_atom_site.'+k); return i>=0&&i<t.length?t[i]:'';};
    const nm=g('label_atom_id').replace(/"/g,'');
    const x=+g('Cartn_x'), y=+g('Cartn_y'), z=+g('Cartn_z');
    if(!nm||isNaN(x)) continue;
    const ch=(g('auth_asym_id')||g('label_asym_id')||'A').slice(0,1);
    let line=(t[0]==='HETATM'?'HETATM':'ATOM  ')+String(serial++).padStart(5)+' ';
    line+=(nm.length>=4?nm:(' '+nm).padEnd(4)).slice(0,4)+' ';
    line+=g('label_comp_id').padStart(3)+' '+ch
      +String(g('auth_seq_id')||g('label_seq_id')).padStart(4)+'    ';
    line+=x.toFixed(3).padStart(8)+y.toFixed(3).padStart(8)+z.toFixed(3).padStart(8);
    line+='  1.00 20.00          ';
    if(withElement) line+=g('type_symbol').padStart(2);
    out.push(line);
  }
  out.push('END');
  return out.join('\n');
}
function sidechainShape(fd){
  if(!fd.sidechains) return null;
  const sc=fd.sidechains; const per=new Map();
  const key=(k)=>fd.chains[sc.pos[k]]+':'+fd.residue_numbers[sc.pos[k]];
  for(let k=0;k<sc.pos.length;k++){
    if(!per.has(key(k))) per.set(key(k),{atoms:new Set(),bonds:new Set()});
    per.get(key(k)).atoms.add(sc.names[k]);
  }
  for(let e=0;e+1<sc.bonds.length;e+=2){
    const i=sc.bonds[e], j=sc.bonds[e+1];
    const a=sc.names[i], b=sc.names[j];
    per.get(key(i)).bonds.add(a<b?a+'-'+b:b+'-'+a);
  }
  return per;
}
// A hydrogen-bearing residue that is NOT in the connectivity table, written
// with no element column - the one combination where hydrogens survived. The
// table protects standard residues by itself (it never names a hydrogen, so
// one attaches to nothing and is dropped); the distance fallback does not.
function checkHydrogens(){
  const row=(n,nm,res,seq,x,y,z)=>'ATOM  '+String(n).padStart(5)+' '
    +(nm.length>=4?nm:(' '+nm).padEnd(4))+' '+res.padStart(3)+' A'
    +String(seq).padStart(4)+'    '
    +x.toFixed(3).padStart(8)+y.toFixed(3).padStart(8)+z.toFixed(3).padStart(8)
    +'  1.00 20.00';
  const rows=[]; let n=1;
  // a zig-zag: a perfectly straight CA trace is collinear and gets no frame
  const add=(res,seq,x0,y0)=>{
    rows.push(row(n++,'N',res,seq,x0-1.2,y0,0));
    rows.push(row(n++,'CA',res,seq,x0,y0,0));
    rows.push(row(n++,'C',res,seq,x0+1.2,y0+0.6,0));
    rows.push(row(n++,'O',res,seq,x0+1.2,y0+1.8,0));
    rows.push(row(n++,'CB',res,seq,x0-0.5,y0+1.4,0));
    rows.push(row(n++,'OG',res,seq,x0+0.3,y0+2.5,0));
    rows.push(row(n++,'HB2',res,seq,x0-1.2,y0+1.6,0.8));   // v3 hydrogen name
    rows.push(row(n++,'1HB',res,seq,x0-1.2,y0+1.6,-0.8));  // v2: count first
  };
  add('SER',1,0,0); add('SER',2,3.3,1.0); add('SER',3,6.6,0);
  add('SER',4,9.9,1.0); add('XYZ',5,13.2,0);   // XYZ is not in the table
  const fd=runParse(rows.join('\n')+'\nEND', true);
  if(!fd.sidechains){ console.log('FAIL hydrogen: the fixture produced no table'); return 1; }
  const kept=[];
  for(let k=0;k<fd.sidechains.pos.length;k++){
    if(/^[0-9]?[HD]/.test(fd.sidechains.names[k])) kept.push(fd.sidechains.names[k]);
  }
  if(kept.length){
    console.log(`FAIL hydrogen: kept ${kept.join(' ')} from a file with no `
      +`element column - they are bonded and drawn as part of the side chain`);
    return 1;
  }
  console.log('PASS  hydrogens dropped with no element column, table and fallback alike');
  return 0;
}

// SAVE AND LOAD. A session stores the WHOLE side-chain table, not just the
// residues that were showing: storing only those made a smaller file and a
// session you could not change your mind in - reload it and no other residue
// could ever be turned on, because its atoms were never written down and the
// file they came from is gone.
//
// Trimmed instead. `names` and `elements` are dropped - nothing reads them to
// draw, they exist so the connectivity table can be applied at capture, which
// has already happened - and coefficients round to 0.01 A, far finer than a
// side chain drawn a few pixels wide.
function checkSaveLoad(){
  const src=fs.readFileSync(path.join(ROOT,'1TIM.cif'),'utf8');
  const fd=runParse(src,false);
  const full=fd.sidechains;
  if(!full){ console.log('FAIL save: 1TIM produced no table'); return 1; }
  const trimmed=sb.trimSidechainTable(full);
  if(!trimmed){ console.log('FAIL save: nothing came back from the trim'); return 1; }
  // EVERY residue, or a reloaded session cannot enable one that was off
  if(trimmed.pos.length!==full.pos.length){
    console.log(`FAIL save: kept ${trimmed.pos.length} of ${full.pos.length} atoms `
      +`- a residue that was not showing could never be turned on again`);
    return 1;
  }
  if(trimmed.names||trimmed.elements){
    console.log('FAIL save: names/elements are still being written - nothing '
      +'reads them to draw and they are a third of the bytes');
    return 1;
  }
  // through JSON, as a saved session goes
  const back=sb.reviveSidechainTable(JSON.parse(JSON.stringify(trimmed)));
  if(!back){ console.log('FAIL load: the saved table did not revive'); return 1; }
  if(back.pos.length!==full.pos.length||back.bonds.length!==full.bonds.length
     ||back.toBackbone.length!==full.toBackbone.length){
    console.log('FAIL load: the revived table is a different shape'); return 1;
  }
  if(!back.toBackbone.length){
    console.log('FAIL load: no backbone links survived the round trip'); return 1;
  }
  for(let k=0;k<back.pos.length;k++){
    if(back.pos[k]!==full.pos[k]||back.frameOf[k]!==full.frameOf[k]){
      console.log(`FAIL load: row ${k} came back different`); return 1;
    }
    for(let c=0;c<3;c++) if(Math.abs(back.coef[k*3+c]-full.coef[k*3+c])>0.01){
      console.log(`FAIL load: row ${k} moved by more than the rounding`); return 1;
    }
  }
  if(back.pos.constructor.name!=='Int32Array'
     ||back.coef.constructor.name!=='Float32Array'){
    console.log(`FAIL load: revived columns are ${back.pos.constructor.name}/`
      +`${back.coef.constructor.name}, not typed arrays`); return 1;
  }
  const kb=(o)=>JSON.stringify(o).length/1024;
  const coordsKb=JSON.stringify(fd.coords.map(c=>c.map(v=>Math.round(v*1000)/1000))).length/1024;
  console.log(`PASS  save/load: whole table, ${trimmed.pos.length} atoms, `
    +`${kb(trimmed).toFixed(0)} KB against ${coordsKb.toFixed(0)} KB of coordinates`);
  return 0;
}

function checkPdbPath(){
  let bad=0;
  for(const f of ['1UBQ.cif','4HHB.cif']){
    const src=fs.readFileSync(path.join(ROOT,f),'utf8');
    const viaCif=sidechainShape(runParse(src,false));
    for(const withEl of [true,false]){
      const viaPdb=sidechainShape(runParse(cifToPdb(src,withEl),true));
      const tag=`${f} (element column ${withEl?'present':'absent'})`;
      if(!viaCif||!viaPdb){ console.log(`FAIL pdb: ${tag} produced no table`); bad++; continue; }
      let diff=0;
      for(const [k,v] of viaCif){
        const w=viaPdb.get(k);
        if(!w){ diff++; continue; }
        for(const a of v.atoms) if(!w.atoms.has(a)) diff++;
        for(const a of w.atoms) if(!v.atoms.has(a)) diff++;
        for(const b of v.bonds) if(!w.bonds.has(b)) diff++;
        for(const b of w.bonds) if(!v.bonds.has(b)) diff++;
      }
      if(diff){ console.log(`FAIL pdb: ${tag} differs from the CIF path in ${diff} atoms/bonds`); bad++; }
      else console.log(`PASS  ${tag} matches the CIF path over ${viaCif.size} residues`);
    }
  }
  return bad;
}
function runParse(text,isPdb){
  const p=isPdb?sb.parsePDB(text):sb.parseCIF(text);
  const m=Array.isArray(p)?p:(p.models||p.frames);
  return sb.convertParsedToFrameData(Array.isArray(m[0])?m[0]:m);
}

let files=process.argv.slice(2);
if(!files.length){
  files=fs.readdirSync(ROOT).filter(f=>/\.cif$/i.test(f)).map(f=>path.join(ROOT,f));
}
let longBonds=0, longOver=0;
let failures=checkFrameBuilders();
failures+=checkAliases();
failures+=checkPdbPath();
failures+=checkHydrogens();
failures+=checkSaveLoad();
for(const file of files) run(file);
if(longBonds){
  const frac=longOver/longBonds;
  // 0.088% today; 1% would mean a whole residue type is being mis-bonded
  if(frac>0.01){
    console.log(`FAIL: ${longOver} of ${longBonds} bonds (${(100*frac).toFixed(2)}%) `
      +`are longer than 2.0 A - a 1,3 pair starts at 2.41, so an entry in `
      +`PROTEIN_SIDECHAIN_BONDS is pairing atoms that are not bonded`);
    failures++;
  } else {
    console.log(`PASS  bond lengths: ${(100*frac).toFixed(3)}% over 2.0 A of ${longBonds}`);
  }
}
console.log(failures?`FAILURES ${failures}`:`all ${files.length} structures carried their side chains`);
process.exit(failures?1:0);

function run(file){
const name=path.basename(file);
const text=fs.readFileSync(file,'utf8');
const p=/\.cif$/i.test(file)?sb.parseCIF(text):sb.parsePDB(text);
const m=Array.isArray(p)?p:(p.models||p.frames); const first=Array.isArray(m[0])?m[0]:m;
const fd=sb.convertParsedToFrameData(first);
const nAt=fd.sidechains? fd.sidechains.pos.length : 0;
// A nucleic-only structure genuinely has none, and that is not a failure.
const anyProtein=(fd.position_types||[]).some(t=>t==='P');
if(!nAt){
  if(anyProtein){ console.log(`FAIL ${name}: protein present but nothing captured`); failures++; }
  else console.log(`skip ${name}: no protein`);
  return;
}
// ONE CONFORMER PER RESIDUE. A residue modelled in two positions writes each
// of its atoms twice - alt A and alt B - and taking both gives a side chain
// with two of every atom, bonded to each other by the distance rule into a
// tangle that is not any real conformer. Several structures here carry
// alternates (3CHY, 6MRR, 2POR, 9FOG), so this is real-data coverage.
{
  const byRes=new Map();
  for(let k=0;k<nAt;k++){
    const owner=fd.sidechains.pos[k];
    if(!byRes.has(owner)) byRes.set(owner,new Set());
    const names=byRes.get(owner);
    if(names.has(fd.sidechains.names[k])){
      console.log(`FAIL ${name}: residue ${owner} has two atoms called `
        +`${fd.sidechains.names[k]} - an alternate conformer was taken as well`);
      failures++; return;
    }
    names.add(fd.sidechains.names[k]);
  }
}
// AND ALMOST NOTHING DROPPED. The unbonded check below cannot see a bad cutoff
// on its own: an atom the cutoff fails to reach is DISCARDED rather than left
// bondless, so tightening the threshold makes atoms vanish silently instead of
// failing. What it costs is measured here - the table against the heavy
// side-chain atoms actually in the file. Only atoms separated by a genuinely
// unmodelled neighbour should go; on 4HHB that is 27 of 2618 (1.0%), against
// 79 (3.0%) with the fragment repair switched off.
{
  const BB=new Set(['N','CA','C','O','OXT']);
  // Only residues that actually became PROTEIN positions. Counting every
  // residue in the file instead swept in nucleic and ligand atoms - on the
  // 1AOI nucleosome that was 60% of the total, and the check failed on correct
  // code.
  const isProt=new Set();
  for(let i=0;i<fd.coords.length;i++){
    if((fd.position_types||[])[i]==='P') isProt.add(fd.chains[i]+':'+fd.residue_numbers[i]);
  }
  const perRes=new Map();
  for(const a of first){
    if(a.element==='H'||a.element==='D') continue;
    // CA excluded: it is the backbone position, already drawn, and no longer
    // duplicated into the table - see toBackbone
    if(BB.has(a.atomName)) continue;
    const key=a.chain+':'+a.resSeq;
    if(!isProt.has(key)) continue;
    if(!perRes.has(key)) perRes.set(key,new Set());
    perRes.get(key).add(a.atomName);      // first-wins by name, as capture does
  }
  let inFile=0;
  for(const [,names] of perRes) if(names.size>0) inFile+=names.size;
  const lost=inFile-nAt;
  // With the chemistry table nothing is dropped at all - measured 0.00% on
  // every structure here - so this is tight. A missing ALIAS shows up right
  // here: an ILE written in v2 names loses its CD1 bond, the atom detaches and
  // vanishes, which at a 2% bound was invisible.
  if(inFile>0 && lost/inFile>0.002){
    console.log(`FAIL ${name}: ${lost} of ${inFile} side-chain atoms `
      +`(${(100*lost/inFile).toFixed(1)}%) never reached the table - the bond `
      +`cutoff is dropping real atoms, not just unmodelled gaps`);
    failures++; return;
  }
}
// THE CA END REACHES THE BACKBONE. The CA is a drawn position already, so the
// table holds no copy of it and the atoms bonded to it are listed in
// toBackbone instead. If that list were lost the side chain would float free of
// the ribbon with nothing joining them - and every other check here would still
// pass, because within the table everything is still perfectly connected.
{
  const sc=fd.sidechains;
  if(sc.names.includes('CA')){
    console.log(`FAIL ${name}: a CA is in the table - it is the backbone `
      +`position and must not be duplicated`);
    failures++; return;
  }
  const owners=new Set();
  for(const row of (sc.toBackbone||[])) owners.add(sc.pos[row]);
  const shouldHave=new Set();
  for(let k=0;k<nAt;k++){
    const rn=fd.position_names[sc.pos[k]];
    const known=lifted.PROTEIN_SIDECHAIN_BONDS[rn];
    if(known && known.some(([a,b])=>a==='CA'||b==='CA')) shouldHave.add(sc.pos[k]);
  }
  for(const o of shouldHave) if(!owners.has(o)){
    console.log(`FAIL ${name}: residue ${o} (${fd.position_names[o]}) has side-chain `
      +`atoms but nothing joining them to its backbone position`);
    failures++; return;
  }
}
// IS THE TABLE ITSELF RIGHT? The check below compares the bonds against the
// table, so it can only prove the code APPLIES the table - not that the table
// is chemically correct. The independent evidence is the coordinates: a wrong
// entry pairs two atoms that are not bonded, and the shortest such pair in a
// residue is a 1,3 neighbour at 2.41 A aromatic, 2.50 A tetrahedral. Real
// bonds run 1.43-1.81 and measure a 1.51 A median here, with 0.088% past 2.0 A
// - individual structures with distorted geometry, 4HHB above all. A wrong
// entry would put a whole residue type past 2.0 and move that figure by
// percent, not hundredths.
FRACTION_CHECK: {
  const sc=fd.sidechains;
  for(let e=0;e+1<sc.bonds.length;e+=2){
    const i=sc.bonds[e], j=sc.bonds[e+1];
    if(sc.frameOf[i]!==sc.frameOf[j]) continue;
    longBonds++;
    const d=Math.hypot(sc.coef[i*3]-sc.coef[j*3],sc.coef[i*3+1]-sc.coef[j*3+1],
                       sc.coef[i*3+2]-sc.coef[j*3+2]);
    if(d>2.0) longOver++;
  }
}
// THE BONDS ARE THE CHEMISTRY'S, EXACTLY. Where the residue type is known its
// connectivity comes from PROTEIN_SIDECHAIN_BONDS rather than from distances,
// so this can be checked against the table itself: every bond the table names
// between two atoms the file modelled must be present, and no others. That
// covers the alias map too - an ILE written in PDB v2 names has CD, not CD1,
// and without the alias its terminal bond goes missing here.
//
// Bond LENGTH is deliberately not asserted. The table says an arginine's NE and
// CZ are bonded and they are, however far apart this particular file put them:
// 4HHB has one at 2.97 A and an asparagine CB-CG at 0.88 A. That is the
// structure's own distorted geometry, and it is exactly the case a distance
// rule got wrong - it dropped those bonds and drew the side chain broken.
{
  const TABLE=lifted.PROTEIN_SIDECHAIN_BONDS, ALIAS=lifted.SIDECHAIN_ATOM_ALIASES;
  const sc=fd.sidechains;
  const rows=new Map();
  for(let k=0;k<nAt;k++){
    if(!rows.has(sc.pos[k])) rows.set(sc.pos[k],[]);
    rows.get(sc.pos[k]).push(k);
  }
  const got=new Map();
  for(let e=0;e+1<sc.bonds.length;e+=2){
    const owner=sc.pos[sc.bonds[e]];
    if(!got.has(owner)) got.set(owner,new Set());
    const a=sc.names[sc.bonds[e]], b=sc.names[sc.bonds[e+1]];
    got.get(owner).add(a<b?a+'-'+b:b+'-'+a);
  }
  for(const [owner,ks] of rows){
    const rn=fd.position_names[owner];
    const known=TABLE[rn];
    if(!known) continue;                       // fallback path, checked above
    const alias=ALIAS[rn]||{};
    const present=new Set(ks.map(k=>alias[sc.names[k]]||sc.names[k]));
    const want=new Set();
    for(const [n1,n2] of known){
      // the CA is the backbone position, not a table row: its bond is recorded
      // in toBackbone and checked separately below
      if(n1==='CA'||n2==='CA') continue;
      if(present.has(n1)&&present.has(n2)) want.add(n1<n2?n1+'-'+n2:n2+'-'+n1);
    }
    const have=got.get(owner)||new Set();
    for(const w of want) if(!have.has(w)){
      console.log(`FAIL ${name}: ${rn} at ${owner} is missing bond ${w}`);
      failures++; return;
    }
    for(const h of have) if(!want.has(h)){
      console.log(`FAIL ${name}: ${rn} at ${owner} has bond ${h}, which is not `
        +`in the chemistry for that residue`);
      failures++; return;
    }
  }
}
const fo=mkFrameObj(fd);
if(!fo.sidechains){
  console.log(`FAIL ${name}: ${nAt} atoms captured, then DROPPED by app.js's frameObj copy`);
  failures++; return;
}
if(fo.sidechains.pos.length!==nAt){
  console.log(`FAIL ${name}: ${nAt} captured, ${fo.sidechains.pos.length} survived`); failures++; return;
}

// and now the renderer step
const vm2=fs.readFileSync(ROOT+'/py2Dmol/resources/viewer-mol.js','utf8');
const k=vm2.indexOf('\n        _materialiseSidechains(');
let a=vm2.indexOf('{',k),d=0,b=a;
for(;b<vm2.length;b++){if(vm2[b]==='{')d++;else if(vm2[b]==='}'){d--;if(!d)break;}}
// ...plus the element-colour pair, so the gold a disulfide is drawn in is
// checked against the shipped table rather than a copy of it
const lift=(name)=>{
  const i=vm2.indexOf('\n        '+name+'(');
  if(i<0) throw new Error('cannot lift '+name+' from viewer-mol.js');
  let x=vm2.indexOf('{',i),dd=0,y=x;
  for(;y<vm2.length;y++){if(vm2[y]==='{')dd++;else if(vm2[y]==='}'){dd--;if(!dd)break;}}
  return vm2.slice(i,y+1);
};
const elStatic=vm2.match(/\n        static get ELEMENT_COLORS\(\)[\s\S]*?\n        \}/);
if(!elStatic) throw new Error('ELEMENT_COLORS is gone from viewer-mol.js');
const Cls=new Function('window','return class V {'+vm2.slice(k,b+1)
  +elStatic[0]+lift('_segmentElementColor')+lift('_segmentElementHalves')+'}')(sb.window);
const v=new Cls(); v.currentObjectName='o';
v._invalidateSegmentCache=function(){ this.cachedSegmentIndices=null; this._invalidated=true; };
v.cachedSegmentIndices=[{stale:true}];
// FIVE RESIDUES, PLUS EVERY CYSTEINE. The sample is deliberately small - this
// walks a 17,789-position ribosome - but a disulfide needs BOTH its cysteines
// materialised, and five arbitrary residues will not contain a pair. Without
// this the disulfide expectations below never fire and pass on an empty set.
const allOwners=[...new Set(Array.from(fd.sidechains.pos))];
const cysOwners=allOwners.filter((i)=>(fd.position_names||[])[i]==='CYS');
const owners=[...new Set([...allOwners.slice(0,5), ...cysOwners])];
v.objectsData={o:{sidechains:new Set(owners)}};
let ss='';
const out=v._materialiseSidechains(fo);
const added=out.coords.length - fo.coords.length;
if(added<owners.length){
  console.log(`FAIL ${name}: ${owners.length} residues switched on, only ${added} atoms appended`);
  failures++; return;
}
// appended, never inserted: existing indices must survive untouched
for(let q=0;q<fo.coords.length;q++){
  if(out.coords[q]!==fo.coords[q]){
    console.log(`FAIL ${name}: position ${q} was disturbed by materialising`); failures++; return; }
}
if(!out.position_types.slice(fo.coords.length).every(t=>t==='L')){
  console.log(`FAIL ${name}: appended atoms are not ligand positions`); failures++; return;
}
// The segment cache keys on frame + object name, neither of which moves when a
// side chain is toggled. Left alone it is reused and nothing new is ever drawn.
if(!v._invalidated){
  console.log(`FAIL ${name}: segment cache was not invalidated`); failures++; return;
}
// VISIBILITY. In the default "show everything" mode this is not empty - it is
// filled with every index that existed at the time. Appending without extending
// it means the atoms are built, sorted, and then filtered out for not being in
// a set written before they existed. This is how they came to be invisible.
{
  const v2=new Cls(); v2.currentObjectName='o';
  v2._invalidateSegmentCache=function(){};
  v2.objectsData={o:{sidechains:new Set(owners)}};
  const all=new Set(); for(let q=0;q<fo.coords.length;q++) all.add(q);
  v2.visiblePositions=all;
  v2.visibilityModel={positions:new Set(all), visibilityMode:'default'};
  const o2=v2._materialiseSidechains(fo);
  for(let q=fo.coords.length;q<o2.coords.length;q++){
    if(!v2.visiblePositions.has(q)){
      console.log(`FAIL ${name}: appended atom ${q} was left out of the visible set`);
      failures++; return; }
  }
  // and turning them back off must not leave indices past the end behind
  v2.objectsData.o.sidechains=null;
  v2._materialiseSidechains(fo);
  for(const q of v2.visiblePositions){
    if(q>=fo.coords.length){
      console.log(`FAIL ${name}: stale index ${q} left in the visible set`);
      failures++; return; }
  }
}
// ...and the explicit bonds must actually become segments. Lifted from the
// renderer's own loop rather than described, since a bond that never becomes a
// segment is never drawn.
{
  const segs=[];
  for(const [i1,i2] of out.bonds){
    if(i1<0||i1>=out.coords.length||i2<0||i2>=out.coords.length) continue;
    segs.push({idx1:i1, idx2:i2});
  }
  const scSegs=segs.filter(g=>g.idx1>=fo.coords.length||g.idx2>=fo.coords.length);
  if(scSegs.length<owners.length){
    console.log(`FAIL ${name}: ${out.bonds.length} bonds but only ${scSegs.length}`
      +` reach a side-chain atom`); failures++; return;
  }
}
// DISULFIDES, found in the geometry between the cysteines actually drawn.
//
// The file's own record is no help: _struct_conn's `disulf` rows are parsed and
// reach convertParsedToFrameData, but they name atoms - chain:seq:SG - and a
// protein's positions are one per residue, so the SG lookup fails and the bond
// is dropped in silence. Measured before this existed: 3PTB's six records in,
// ZERO bonds out, every bond that reached the renderer belonging to the ligand.
//
// The cutoff is 2.5 A and is not a guess. Over every SG-SG pair in this corpus
// the bonded ones run 1.79-2.09 A and the next pair is at 3.36 - a 1.3 A gap,
// so anything from 2.1 to 3.3 finds the same disulfides.
const SS_EXPECT = { '3PTB': 6, '2R8S': 5, '4HHB': 0, '1UBQ': 0 };
{
  const want = SS_EXPECT[name];
  const got = (v.disulfides || []).length;
  if (want !== undefined && got !== want) {
    // 2R8S is the one to read twice: the file carries SEVEN disulf records but
    // has FIVE disulfides. CYS L194 and H148 are each modelled in two alt-loc
    // conformers and the file records the bond once per conformer. Capture
    // keeps the first conformer only, so five is the honest count.
    console.log(`FAIL ${name}: ${got} disulfides, expected ${want}`);
    failures++; return;
  }
  // every one found must be a real BOND, or it is detected and then not drawn
  const key = (p) => Math.min(p[0], p[1]) + '-' + Math.max(p[0], p[1]);
  const bondSet = new Set(out.bonds.map(key));
  for (const p of (v.disulfides || [])) {
    if (!bondSet.has(key(p))) {
      console.log(`FAIL ${name}: a disulfide was found but never bonded`);
      failures++; return;
    }
    // ...and never a residue to itself: alt-loc conformers of one cysteine sit
    // ~1.8 A apart, inside the cutoff
    const o1 = v.sidechainMap.get(p[0]); const o2 = v.sidechainMap.get(p[1]);
    if (o1 && o2 && o1.owner === o2.owner) {
      console.log(`FAIL ${name}: a disulfide joined a residue to itself`);
      failures++; return;
    }
  }
  // ...AND IT MUST BECOME A DRAWN SEGMENT, not just an entry in a bond list.
  // The renderer's explicit-bond loop is what turns one into the other, and it
  // is reproduced here rather than described: a bond that never becomes a
  // segment is never drawn, which is a failure no bond-list assertion can see.
  // Both ends are side-chain atoms, position type 'L', so the segment comes out
  // 'L' - the ligand-stick path, the same one the rest of the side chain uses.
  for (const p of (v.disulfides || [])) {
    const t1 = out.position_types[p[0]];
    const t2 = out.position_types[p[1]];
    if (t1 !== 'L' || t2 !== 'L') {
      console.log(`FAIL ${name}: a disulfide joins position types ${t1}/${t2},`
        + ` so it would not be drawn as a stick`);
      failures++; return;
    }
    const c1 = out.coords[p[0]]; const c2 = out.coords[p[1]];
    const d = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
    if (!(d > 1.5 && d < 2.5)) {
      console.log(`FAIL ${name}: a disulfide is ${d.toFixed(2)} A long`);
      failures++; return;
    }
  }
  // GOLD, following PyMOL. A disulfide drawn in the residue's own colour is
  // indistinguishable from the carbon skeleton either side of it, and reading
  // as a cross-link is the whole point of drawing one.
  for (const p of (v.disulfides || [])) {
    const c = v._segmentElementColor({ idx1: p[0], idx2: p[1] });
    if (!c) {
      console.log(`FAIL ${name}: a disulfide takes no element colour`);
      failures++; return;
    }
    // GOLD, TESTED AS A COLOUR AND NOT AGAINST THE TABLE IT CAME FROM. The
    // first version of this compared the result with Cls.ELEMENT_COLORS.S -
    // the same table the code reads - so recolouring sulfur battleship grey
    // passed. It has to be an independent statement about the hue: warm,
    // bright, and not grey.
    const warm = c.r > 200 && c.g > 150 && c.b < 130;
    const notGrey = (Math.max(c.r, c.g) - c.b) > 60;
    if (!warm || !notGrey) {
      console.log(`FAIL ${name}: a disulfide is rgb(${c.r},${c.g},${c.b}),`
        + ` which is not the gold PyMOL draws sulfur in`);
      failures++; return;
    }
  }
  // ...and a MIXED bond is not. This renderer draws a bond as one stick with
  // one colour, where PyMOL splits it at the midpoint - so colouring a CB-SG
  // bond by either end would be a coin toss. Only a bond whose two ends agree
  // takes an element colour.
  {
    let mixed = null;
    for (const [x, y] of out.bonds) {
      const ex = (v.sidechainMap.get(x) || {}).el;
      const ey = (v.sidechainMap.get(y) || {}).el;
      if (ex && ey && ex !== ey && (ex === 'S' || ey === 'S')) { mixed = [x, y]; break; }
    }
    if (mixed && v._segmentElementColor({ idx1: mixed[0], idx2: mixed[1] })) {
      console.log(`FAIL ${name}: a mixed carbon/sulfur bond took an element colour`);
      failures++; return;
    }
  }
  if (got) ss = ` ${got} disulfide${got > 1 ? 's' : ''} in gold`;
}
console.log(`PASS ${name.padEnd(12)} ${String(fd.coords.length).padStart(5)} positions, `
  +`${String(nAt).padStart(5)} side-chain atoms carried, ${added} appended for ${owners.length} residues${ss}`);
}
