// Gesture-degrade tests for viewer-mol.js: the outline drop during a gesture,
// the inertia veto, and the settle that puts the outline back.
//
//   node tests/interaction.js
//
// viewer-mol.js needs a DOM to instantiate, so rather than mock a browser the
// methods under test are LIFTED OUT OF THE SOURCE TEXT and run against a mock
// canvas. That way the logic exercised is the shipped code, not a paraphrase of
// it that can drift away from it silently.
//
// What is being pinned down:
//   * a cheap structure is NEVER degraded - the drawing must not change under
//     the user for no reason, which is why gesture switching was removed once
//     before, and the budget is the whole answer to that objection;
//   * the inertia veto and the outline drop agree, because a coasting spin is
//     not a gesture (isDragging is already false) and so draws at full cost;
//   * the settle RESCHEDULES while a gesture is still running. Bailing out was
//     a real bug: the timer only had to land inside a running gesture once and
//     the settle was lost for good, stranding the viewer with no outline.

const fs=require('fs');
const src=fs.readFileSync('py2Dmol/resources/viewer-mol.js','utf8');
// _materialiseSidechains rebuilds atoms through the cartoon plugin's own
// localFrame - the same function web/utils.js stored them with. Load the real
// plugin rather than stub it: two implementations of that frame is exactly how
// capture and reconstruction would drift apart.
global.window = { dispatchEvent(){}, addEventListener(){}, py2dmol_customColors:{} };
global.Event = function Event(){};
eval(fs.readFileSync('py2Dmol/resources/viewer-cartoon.js','utf8'));
// helpers the lifted methods close over in the real file
const molSrc = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
// new Function bodies see globals only, so the lifted methods find it there
eval('global.' + molSrc.split('\n').find((l) => l.includes('function hexToRgb'))
    .trim().replace('function hexToRgb', 'hexToRgb = function'));
// ...and the small predicates they call, for the same reason
{
    const m = molSrc.match(/\n    const isPerspective = [\s\S]*?;\n/);
    if (!m) throw new Error('isPerspective not found in viewer-mol.js');
    eval('global.' + m[0].trim().replace('const ', ''));
}
// module-level constants the lifted methods close over, taken from the source
// so the test scores the shipped values rather than a copy of them
for (const name of ['SELECTION_HALO_CSS', 'SELECTION_HALO_GAIN',
    'SELECTION_HALO_MIN_PX', 'SELECTION_HALO_MAX_PX', 'SELECTION_HALO_RADIUS_FRAC', 'SIDECHAIN_WIDTH', 'SIDECHAIN_REACH_A',
    'PICK_WIDTH_SCALE', 'CONTACT_WIDTH_A', 'HOVER_TEXT_LIGHT_CSS',
    'HOVER_TEXT_DARK_CSS', 'HOVER_TEXT_MARGIN']) {
    const line = molSrc.split('\n').find((l) => l.trim().startsWith('const ' + name + ' ='));
    if (!line) throw new Error('constant not found in viewer-mol.js: ' + name);
    eval('global.' + line.trim().replace('const ', ''));
}
// orient's rotation solver, scored as shipped
eval(fs.readFileSync('web/utils.js','utf8').match(
  /function bestViewTargetRotation_relaxed_AUTO[\s\S]*?\n\}\n/)[0]);
const names=['_inertiaAllowed','_frameOverBudget','smoothAnimationOk','_scheduleSettle','_materialiseSidechains','pickGroupAt','selectionInk','_remapSidechains','_colorPositionFor','_sidechainColorOf','_colorSegmentPosition','_syncSaveButtonMode','hasBasesFor','setBasesFor','hasElementsFor','setElementsFor','sidechainOwners','_segmentElementHalves','_paintSelectionHalo','_paintOverlays','_paintHoverReadout','hoverSet','_snapshotCleanFrame','clipSlabDefault','clipViewExtent','setClipSlab','clipSlabOn','clipAccepts','clipCoverage','clipFadeWidth','setClipFade','_clipReach','residuesWithin','_atomsOfResidues','_isSidechainSegment','backboneHiddenSet','backboneHiddenAt','setBackboneHiddenFor','framingPositions','showAll','resetVisibility','_repaintOverlays','setHover','_calculateSegmentWidthMultiplier','sidechainOwners','hasSidechainsFor','_shadowPairExcluded','_resolveContactToIndices','pickResidueAt','_pickable','beginSelectionPreview','updateSelectionPreview','endSelectionPreview','_invalidateSelectionPreview','_ensurePickProjection','_projectForPicking','_rotateCoords','_computeViewCentre','_gpuWillDraw','_tubeGPUWillTake','_gpuWillTake','_ensureRotated'];
const body={};
for(const nm of names){
 const i=src.indexOf('\n        '+nm+'(');
 if(i<0) throw new Error('method not found: '+nm);
 // brace-match from the opening {
 let j=src.indexOf('{',i), d=0, k=j;
 for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
 body[nm]=src.slice(i,k+1);
}
// ...and the STATICS the lifted methods reach through this.constructor. Only
// the named methods are lifted, so a static one of them depends on is simply
// absent and the method throws on a property of undefined.
const statics=(src.match(/\n        static get ELEMENT_COLORS\(\)[\s\S]*?\n        \}/)||[''])[0];
const Cls=new Function('document','window','return class V {'+names.map(n=>body[n]).join('\n')+statics+'}')
 ({createElement:()=>mkCanvas(0,0)}, global.window);
function mkCtx(canvas){const ops=[];return {ops,canvas,fillStyle:'',
 setTransform(){ops.push(['setTransform']);},save(){},restore(){},
 clearRect(){ops.push(['clearRect']);},fillRect(){ops.push(['fillRect']);},
 drawImage(img,x,y,w,h){ops.push(['drawImage',x,y,w,h]);}};}
function mkCanvas(w,h){const c={width:w,height:h};c.getContext=()=>c._c||(c._c=mkCtx(c));return c;}
global.mkCanvas=mkCanvas;

function mk(){
 const v=new Cls();
 v.canvas=mkCanvas(1600,1600); v.ctx=mkCtx(v.canvas);
 v.viewerState={zoom:1}; v.backgroundColor='#fff'; v.isTransparent=false;
 v.segmentIndices=new Array(500); v.LARGE_MOLECULE_CUTOFF=1000;
 v.render=function(){this.rendered=(this.rendered||0)+1;};
 return v;
}
let pass=0,fail=0;
const t=(nm,fn)=>{try{fn();console.log('PASS',nm);pass++;}catch(e){console.log('FAIL',nm,'-',e.message);fail++;}};
const eq=(a,b,m)=>{if(a!==b)throw new Error(m+' got '+a+' want '+b);};

// a cost is only evidence once there are three samples behind it - a drag's
// first full-quality frame is its most expensive, so one sample is a warm-up
const cost=(v,ms)=>{v._lastInkedMs=ms; v._inkedMs=(ms===undefined)?[]:[ms,ms,ms];};
t('inertia follows the same budget',()=>{
 const v=mk(); cost(v,10); eq(v._inertiaAllowed(),true,'cheap');
 cost(v,60); eq(v._inertiaAllowed(),false,'expensive');
 cost(v,undefined); eq(v._inertiaAllowed(),true,'unknown cost');
 cost(v,10); v.segmentIndices=new Array(5000);
 eq(v._inertiaAllowed(),false,'segment floor');
});
t('one expensive sample is not enough to veto an animation',()=>{
 // the warm-up frame. Vetoing on it jumped orients that would have flown fine.
 const v=mk(); v._lastInkedMs=9999; v._inkedMs=[9999];
 eq(v._inertiaAllowed(),true,'single sample');
 v._inkedMs=[9999,9999];
 eq(v._inertiaAllowed(),true,'two samples');
 v._inkedMs=[9999,9999,9999];
 eq(v._inertiaAllowed(),false,'three samples');
});
t('the settle reschedules instead of giving up mid-gesture',()=>{
 const v=mk(); const timers=[];
 global.setTimeout=(fn)=>{timers.push(fn);return timers.length;};
 global.clearTimeout=()=>{};
 v._inkSkipped=true; v.isDragging=true;
 v._scheduleSettle();
 timers.shift()();                       // fires while the drag is still running
 if(!timers.length) throw new Error('settle was dropped mid-gesture - the outline'
   +' would never come back');
 v.isDragging=false;
 timers.shift()();                       // gesture over
 eq(v.rendered,1,'renders once the gesture ends');
 eq(v._inkSkipped,false,'clears the skipped flag');
});
t('orient jumps rather than flies when a frame is unaffordable',()=>{
 // the shipped decision, and the shipped wind-back, exercised together
 const v=mk();
 const anim={duration:1000,startTime:0,active:true};
 const start=(now)=>{                       // mirrors web/app.js
  anim.startTime=now;
  if(v.smoothAnimationOk && !v.smoothAnimationOk())
   anim.startTime=now-(anim.duration||0);
  return anim.startTime;
 };
 // cheap structure: the clock is NOT wound back, so it really animates
 cost(v,10); v.segmentIndices=new Array(500);
 let now=10000; start(now);
 eq(now-anim.startTime,0,'cheap: elapsed at first frame');
 // expensive: elapsed already >= duration, so frame one takes the completion
 // path and every end-of-orient step runs exactly once
 cost(v,80); now=20000; start(now);
 if(now-anim.startTime < anim.duration)
  throw new Error('expensive orient still animates: elapsed '+(now-anim.startTime)
   +' < duration '+anim.duration);
 // and the segment floor triggers it too, with no cost ever reported
 cost(v,undefined); v.segmentIndices=new Array(5000);
 now=30000; start(now);
 if(now-anim.startTime < anim.duration)
  throw new Error('large-segment orient still animates');
});

// ---- SIDE CHAINS ------------------------------------------------------------
// A switched-on residue's atoms become ordinary 'L' positions APPENDED to the
// end. Appended, because every position index already in use - selections,
// colour and sse overrides, PAE rows, the sequence strip - has to keep meaning
// what it meant.
function scFixture() {
    // A pleated trace at a REAL CA-CA spacing: localFrame refuses a step that
    // is not one (it is how it detects a chain break), so a fixture with the
    // wrong stride silently produces no frame and no atoms.
    const coords = [];
    for (let i = 0; i < 6; i++) coords.push([3.3 * i, i % 2 ? 1 : -1, 0]);
    return {
        coords,
        position_types: ['P', 'P', 'P', 'P', 'P', 'P'],
        chains: ['A', 'A', 'A', 'A', 'A', 'A'],
        position_names: ['ALA', 'ALA', 'LEU', 'ALA', 'ALA', 'ALA'],
        residue_numbers: [1, 2, 3, 4, 5, 6],
        sidechains: {
            pos: new Int32Array([2, 2]),
            frameOf: new Int32Array([2, 2]),
            coef: new Float32Array([0.6, 1.2, 0.5, 1.1, 2.3, 1.0]),
            bonds: new Int32Array([0, 1]),          // CB-CG
            toBackbone: new Int32Array([0]),        // CB joins the backbone CA
            names: ['CB', 'CG'],
            elements: ['C', 'C'],
        },
    };
}
function scViewer(show) {
    const v = new Cls();
    v.currentObjectName = 'obj';
    v.objectsData = { obj: show ? { sidechains: new Set(show) } : {} };
    return v;
}

t('nothing is materialised until a residue asks', () => {
    const d = scFixture();
    const out = scViewer(null)._materialiseSidechains(d);
    if (out !== d) throw new Error('data was rebuilt for an empty selection');
});

t('a switched-on residue appends its atoms as ligand positions', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const out = v._materialiseSidechains(d);
    if (out.coords.length !== 8) {
        throw new Error('expected 2 atoms appended, got ' + (out.coords.length - 6));
    }
    // existing indices untouched - the whole reason they are appended
    for (let i = 0; i < 6; i++) {
        if (out.coords[i] !== d.coords[i] || out.position_types[i] !== 'P') {
            throw new Error('position ' + i + ' was disturbed');
        }
    }
    for (let i = 6; i < 8; i++) {
        if (out.position_types[i] !== 'L') throw new Error('atom ' + i + ' is not a ligand position');
        if (out.chains[i] !== 'A') throw new Error('atom ' + i + ' lost its chain');
    }
    // bonds are given EXPLICITLY, so the ligand distance guess never runs
    if (!out.bonds || out.bonds.length !== 2) {
        throw new Error('expected 2 explicit bonds, got ' + (out.bonds || []).length);
    }
    if (!v.sidechainMap || v.sidechainMap.size !== 2) {
        throw new Error('no sidechainMap for the cartoon to re-place them with');
    }
});

// A SELECTION OUTLIVES THE COORDINATE ARRAY IT WAS MADE AGAINST. A click in the
// 3D view can land on a side-chain atom, which selects an APPENDED index; hide
// the side chains and that index points past the end of the array. Everything
// that reads the selection then asks about a position that no longer exists -
// the panel tallied it as not-visible, so the main chain read as HALF HIDDEN
// the moment side chains went off, with nothing about the main chain changed.
t('hiding side chains drops their atoms from the selection, not just visibility', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const shown = v._materialiseSidechains(d);
    if (shown.coords.length !== 8) throw new Error('fixture did not materialise');
    // as if the user had clicked residue 2 and one of its atoms
    v.residueSelection = new Set([2, 7]);
    v.visiblePositions = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    v.visibilityModel = { positions: new Set([2, 7]) };
    // ...and now they switch side chains off
    v.objectsData.obj.sidechains = null;
    v._materialiseSidechains(d);
    if (v.residueSelection.has(7)) {
        throw new Error('the selection kept index 7, which no longer exists -'
            + ' every tally over the selection now asks about a dead position');
    }
    if (!v.residueSelection.has(2)) throw new Error('the real residue was pruned too');
    if (v.visiblePositions.has(7) || v.visibilityModel.positions.has(7)) {
        throw new Error('a visibility set kept the dead index');
    }
});

t('a residue that was never captured is simply not drawn', () => {
    const d = scFixture();
    // residue 4 has no atoms in the table; residue 2 does but is not asked for
    const out = scViewer([4])._materialiseSidechains(d);
    if (out !== d) throw new Error('rebuilt for a residue with no side-chain data');
    // and the guard is the SELECTION, not a broken frame - prove residue 2 works
    if (scViewer([2])._materialiseSidechains(d).coords.length !== 8) {
        throw new Error('the fixture cannot materialise at all, so the negative'
            + ' case above proves nothing');
    }
});


t('clicking a side chain selects its residue, not loose atoms', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const out = v._materialiseSidechains(d);
    v.positionTypes = out.position_types;
    v.segmentIndices = out.bonds.map(([a, b]) => ({ type: 'L', idx1: a, idx2: b }));
    // every appended atom must resolve to residue 2
    for (let i = d.coords.length; i < out.coords.length; i++) {
        const pick = v.pickGroupAt(i);
        if (pick.length !== 1 || pick[0] !== 2) {
            throw new Error('atom ' + i + ' picked ' + JSON.stringify(pick)
                + ' instead of its residue - the sequence strip has no row for'
                + ' a ligand position, so the click would appear to do nothing');
        }
    }
    // and an ordinary residue is still itself
    if (JSON.stringify(v.pickGroupAt(3)) !== '[3]') {
        throw new Error('a plain residue stopped picking as itself');
    }
});

t('a selected residue is outlined together with its side chain', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const out = v._materialiseSidechains(d);
    v.residueSelection = new Set([2]);
    const ink = v.selectionInk();
    for (let i = d.coords.length; i < out.coords.length; i++) {
        if (!ink.has(i)) throw new Error('atom ' + i + ' is not inked with its residue');
    }
    // residueSelection itself must stay residues only: the sequence strip maps
    // its entries to rows, and the side-chain toggle asks whether its own set
    // already contains them
    if (v.residueSelection.size !== 1 || !v.residueSelection.has(2)) {
        throw new Error('loose atoms leaked into residueSelection');
    }
    // an unselected residue's side chain is not inked
    v.residueSelection = new Set([3]);
    const ink2 = v.selectionInk();
    for (let i = d.coords.length; i < out.coords.length; i++) {
        if (ink2.has(i)) throw new Error('atom ' + i + ' inked for the wrong residue');
    }
});


t('show / hide / show does not corrupt the bonds', () => {
    // setCoords PERSISTS the bond list onto the object and _loadFrameData
    // reads it back, so a materialise that appends to whatever it is handed
    // appends to the PREVIOUS run's list. This walks the real cycle.
    const d = scFixture();
    const v = scViewer([2]);
    // stand in for setCoords' write-back: whatever comes out is what goes in
    const cycle = (show) => {
        v.objectsData.obj.sidechains = show ? new Set(show) : null;
        const out = v._materialiseSidechains(d);
        d.bonds = out.bonds;          // this is what setCoords persists
        return out;
    };
    const first = cycle([2]);
    const nOn = first.coords.length - 6;
    const nBonds = first.bonds.length;
    cycle(null);                       // hide
    const again = cycle([2]);          // show
    if (again.coords.length - 6 !== nOn) {
        throw new Error('second show appended ' + (again.coords.length - 6)
            + ' atoms, first appended ' + nOn);
    }
    if (again.bonds.length !== nBonds) {
        throw new Error('bonds grew across a show/hide/show cycle: '
            + nBonds + ' -> ' + again.bonds.length
            + ' - the extra ones point at atoms that have since been reused');
    }
    // every bond must reach a position that exists
    for (const [a, b] of again.bonds) {
        if (a >= again.coords.length || b >= again.coords.length) {
            throw new Error('bond ' + a + '-' + b + ' points past the end');
        }
    }
    // and hiding must leave nothing dangling behind either
    const off = cycle(null);
    for (const [a, b] of (off.bonds || [])) {
        if (a >= off.coords.length || b >= off.coords.length) {
            throw new Error('hiding left bond ' + a + '-' + b + ' behind');
        }
    }
});

t('a changed selection does not keep the old residue\'s atoms', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const a = v._materialiseSidechains(d);
    d.bonds = a.bonds;
    // residue 3 has no atoms in the table, so switching to it must leave none
    v.objectsData.obj.sidechains = new Set([3]);
    const b = v._materialiseSidechains(d);
    if (b.coords.length !== 6) {
        throw new Error('switching to a residue with no atoms left '
            + (b.coords.length - 6) + ' behind');
    }
    if ((b.bonds || []).some(([x, y]) => x >= 6 || y >= 6)) {
        throw new Error('bonds to the old selection survived');
    }
});


// ---- ORIENT -----------------------------------------------------------------
// The centre/extent maths from app.js's orient, lifted as source text so this
// scores the shipped arithmetic rather than a paraphrase of it.
const appSrc = fs.readFileSync('web/app.js', 'utf8');
const orientBody = (() => {
    const a = appSrc.indexOf('        // Calculate extent from selected positions');
    const b = appSrc.indexOf('// Calculate standard deviation for selected positions');
    if (a < 0 || b < 0) throw new Error('orient extent block not found in web/app.js');
    return appSrc.slice(a, b);
})();
function orientExtent(coordsForBestView) {
    const sum = [0, 0, 0];
    for (const c of coordsForBestView) { sum[0]+=c[0]; sum[1]+=c[1]; sum[2]+=c[2]; }
    const visibleCenter = sum.map((x) => x / coordsForBestView.length);
    let visibleExtent = null, frameExtent = 0;
    // eslint-disable-next-line no-new-func
    const f = new Function('coordsForBestView', 'visibleCenter',
        'let visibleExtent=null, frameExtent=0;' + orientBody
        + 'return {visibleExtent, frameExtent};');
    return { visibleCenter, ...f(coordsForBestView, visibleCenter) };
}

t('orienting on ONE residue produces a usable centre and extent', () => {
    const { visibleCenter, visibleExtent } = orientExtent([[10, 20, 30]]);
    // this is the bug: the extent of a single point is 0, which is falsy, and
    // the branch that sets the target centre was guarded on truthiness
    if (!(visibleExtent > 0)) {
        throw new Error('a single residue still has zero extent, so orient will'
            + ' skip its target-centre branch and do nothing');
    }
    if (visibleCenter[0] !== 10 || visibleCenter[1] !== 20 || visibleCenter[2] !== 30) {
        throw new Error('centre is not the residue itself');
    }
});

t('two adjacent residues do not orient to an illegible zoom', () => {
    // 3.8 A apart: a real CA-CA step, 1.9 A of extent on its own
    const { visibleExtent } = orientExtent([[0, 0, 0], [3.8, 0, 0]]);
    if (visibleExtent < 4) {
        throw new Error('extent ' + visibleExtent.toFixed(2)
            + ' A would ask for a magnification nothing is legible at');
    }
});

t('a whole structure is not affected by the floor', () => {
    // a 60 A blob: its own extent must survive untouched
    const coords = [];
    for (let i = 0; i < 200; i++) {
        const th = i * 2.4;
        coords.push([30 * Math.cos(th), 30 * Math.sin(th), (i - 100) * 0.3]);
    }
    const { visibleCenter, visibleExtent } = orientExtent(coords);
    // the true answer, computed here rather than assumed
    let want = 0;
    for (const c of coords) {
        want = Math.max(want, Math.hypot(c[0] - visibleCenter[0],
            c[1] - visibleCenter[1], c[2] - visibleCenter[2]));
    }
    if (want < 10) throw new Error('fixture is too small to test the floor');
    if (Math.abs(visibleExtent - want) > 1e-9) {
        throw new Error('the floor changed a real extent: got '
            + visibleExtent.toFixed(2) + ', expected ' + want.toFixed(2));
    }
});

t('orient keeps the current rotation when there is nothing to orient', () => {
    // one point has no plane to face, so the rotation must not be invented
    const R = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
    const out = bestViewTargetRotation_relaxed_AUTO([[1, 2, 3]], R);
    if (out !== R) throw new Error('a single position changed the rotation');
    const same = bestViewTargetRotation_relaxed_AUTO([[1, 2, 3], [1, 2, 3]], R);
    if (same !== R) throw new Error('two identical positions changed the rotation');
});


t('every per-position array grows with the coordinates', () => {
    // setCoords feeds each of these through _setDataField, which SILENTLY
    // replaces an array whose length does not match the coordinate count with
    // a default. Missing plddts that way filled every position with 50 - the
    // low-confidence band - and an AlphaFold model turned entirely red the
    // moment a side chain was shown. No warning, no error, just the wrong
    // colour, so the only defence is checking the lengths agree.
    const d = scFixture();
    d.plddts = [95, 92, 88, 91, 70, 65];
    const out = scViewer([2])._materialiseSidechains(d);
    const n = out.coords.length;
    if (n <= d.coords.length) throw new Error('nothing was appended');
    // the five _setDataField reads, by the names the frame data uses
    for (const f of ['plddts', 'chains', 'position_types',
        'position_names', 'residue_numbers']) {
        if (!out[f]) throw new Error(f + ' went missing');
        if (out[f].length !== n) {
            throw new Error(f + ' is ' + out[f].length + ' long for ' + n
                + ' positions - setCoords will silently replace it with defaults');
        }
    }
    // pLDDT is per residue, so an atom carries its residue's own confidence;
    // anything else recolours the side chain against its own backbone
    for (let i = d.coords.length; i < n; i++) {
        if (out.plddts[i] !== d.plddts[2]) {
            throw new Error('atom ' + i + ' has pLDDT ' + out.plddts[i]
                + ', its residue has ' + d.plddts[2]);
        }
    }
    // and the residues' own values are untouched
    for (let i = 0; i < d.coords.length; i++) {
        if (out.plddts[i] !== d.plddts[i]) throw new Error('residue ' + i + ' lost its pLDDT');
    }
});

t('a structure with no pLDDT is not given one', () => {
    const d = scFixture();          // no plddts at all
    const out = scViewer([2])._materialiseSidechains(d);
    if (out.plddts) throw new Error('invented pLDDT data for a structure with none');
});


// ---- SELECTION PANEL --------------------------------------------------------
// The panel IS the state: it appears with a selection and goes away without
// one. Lifted from web/app.js and run against a stub DOM, because "a panel that
// never appears" and "a panel that never hides" both look like nothing at all
// until someone uses the app.
const panelBody = (() => {
    const a = appSrc.indexOf('    function updateSelectionToolsState() {');
    if (a < 0) throw new Error('updateSelectionToolsState not found in web/app.js');
    let b = appSrc.indexOf('{', a), d = 0, k = b;
    for (; k < appSrc.length; k++) {
        if (appSrc[k] === '{') d++;
        else if (appSrc[k] === '}') { d--; if (!d) break; }
    }
    // ...and syncSelectionToggles with it: the panel calls it, so lifting one
    // without the other leaves the panel throwing on an undefined function.
    const lift = (name) => {
        // nested (four spaces) or top level - the panel calls both kinds
        let i = appSrc.indexOf('    function ' + name + '(');
        if (i < 0) i = appSrc.indexOf('\nfunction ' + name + '(');
        if (i < 0) throw new Error(name + ' not found in web/app.js');
        let j = appSrc.indexOf('{', i), dd = 0, kk = j;
        for (; kk < appSrc.length; kk++) {
            if (appSrc[kk] === '{') dd++;
            else if (appSrc[kk] === '}') { dd--; if (!dd) break; }
        }
        return appSrc.slice(i, kk + 1);
    };
    return appSrc.slice(a, k + 1) + '\n' + lift('syncSelectionToggles')
        + '\n' + lift('describeSelectionRanges');
})();
// The mode select, as much of one as the panel touches: a value, a disabled
// flag, and one option it hides where the selection has no nucleotides.
function modeSelectNode() {
    return {
        value: '', disabled: false, hidden: null,
        _opts: { plate: { hidden: false } },
        querySelector(sel) {
            const m = /option\[value="([^"]+)"\]/.exec(sel);
            return m ? this._opts[m[1]] || null : null;
        },
    };
}
function panelRun(selection, sidechained = new Set(), hasContact = false, types = null) {
    const nodes = {
        selectionTools: { classList: { toggle(c, on) { this._on = on; } } },
        selectionPanel: { hidden: null },
        selectionPanelCount: { textContent: null },
        contactRow: { hidden: null },
        clearAllResidues: { disabled: null },
        elementsShowToggle: { checked: false, indeterminate: false },
        mainchainShowToggle: { checked: false, indeterminate: false },
        sidechainModeSelect: modeSelectNode(),
        sidechainShowToggle: { checked: false, indeterminate: false, hidden: null },
        contactShowToggle: { checked: false, indeterminate: false },
        contactColorButton: { hidden: null, parentElement: { hidden: null } },
        contactWidthSlider: { hidden: null, value: null },
        sidechainRow: { hidden: null },
        selSsSelect: { hidden: null, disabled: null },
    };
    const doc = { getElementById: (id) => nodes[id] || null };
    // eslint-disable-next-line no-new-func
    // the two label refreshers it calls at the end are covered by their own
    // tests; here they only need to exist
    // findContact is defined next to the panel function in app.js; the panel
    // asks it whether the pair already has a contact, to choose Add or Remove
    const f = new Function('document', 'getActiveSelection', 'viewerApi',
        'findContact', 'contactSlots',
        panelBody + '; return updateSelectionToolsState;')(
        doc, () => selection,
        { renderer: {
            hasSidechainsFor: (p2) => p2.some((i) => sidechained.has(i)),
            hasElementsFor: (p2) => p2.some((i) => sidechained.has(i)),
            hasBasesFor: (p2) => !!types && p2.some((i) => types[i] === 'D' || types[i] === 'R'),
            hasSseFor: (p2) => (types ? p2.some((i) => types[i] === 'P') : true),
            sidechainOwners: () => sidechained,
            positionTypes: types || [],
            visiblePositions: null,
            currentObjectName: 'obj',
            objectsData: { obj: {} },
        } },
        // a usable shape, not a bare {}: the panel reads the contact's stored
        // weight to load the width slider
        () => (hasContact ? { obj: { contacts: [['A', 1, 'B', 2, 1.5]] }, i: 0 } : null),
        // the chain form keeps its weight at 4 and colour at 5; the bare-index
        // form at 2 and 3 - see contactSlots in app.js
        (c) => ((typeof c[0] === 'number' && typeof c[1] === 'number')
            ? { w: 2, col: 3 } : { w: 4, col: 5 }));
    // querySelectorAll on the tools group: the enable/disable sweep
    nodes.selectionTools.querySelectorAll = () => [];
    global.window = global.window || {};
    global.window.refreshSelectionSwatches = () => {};
    f();
    return nodes;
}

t('the selection panel appears with a selection and hides without one', () => {
    const empty = panelRun(null);
    if (empty.selectionPanel.hidden !== true) {
        throw new Error('panel is showing with nothing selected - every control'
            + ' in it is a no-op there');
    }
    const picked = panelRun([4, 5, 6]);
    if (picked.selectionPanel.hidden !== false) {
        throw new Error('panel stayed hidden with 3 residues selected');
    }
});

t('the panel says how big the selection is, and which residues', () => {
    // the count changes what the buttons do; the ranges say what they will do
    // it to, which is what you check before pressing the one that deletes them
    if (panelRun([4]).selectionPanelCount.textContent !== '1 residue') {
        throw new Error('singular count is wrong: '
            + panelRun([4]).selectionPanelCount.textContent);
    }
    if (panelRun([4, 5]).selectionPanelCount.textContent !== '2 residues') {
        throw new Error('plural count is wrong');
    }
    if (panelRun(null).selectionPanelCount.textContent !== '') {
        throw new Error('a stale count survived the selection being cleared');
    }
    // ...and the ranges themselves, scored on their own: by chain, consecutive
    // NUMBERS run together, a gap in the numbering breaking the run
    const ranges = new Function('viewerApi', 'return (' + (() => {
        const src = fs.readFileSync('web/app.js', 'utf8');
        const i = src.indexOf('\nfunction describeSelectionRanges(');
        let j = src.indexOf('{', i), d = 0, k = j;
        for (; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) break; }
        }
        return src.slice(i + 1, k + 1);
    })() + ')')({ renderer: {
        chains: ['A', 'A', 'A', 'A', 'A', 'B', 'B'],
        residueNumbers: [11, 12, 13, 20, 21, 5, 7],
    } });
    const got = ranges([0, 1, 2, 3, 4, 5, 6]);
    if (got !== 'A 11-13, 20-21; B 5, 7') {
        throw new Error('ranges read "' + got + '", expected "A 11-13, 20-21; B 5, 7"');
    }
});

t('the panel keeps two matching part rows, with SSE and Copy below them', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const need = ['sidechainModeSelect', 'sidechainShowToggle', 'elementsShowToggle',
        'mainchainShowToggle', 'contactShowToggle',
        'scColorButton', 'selColorButton', 'selSsSelect'];
    for (const id of need) {
        if (!html.includes('id="' + id + '"')) throw new Error('missing control: ' + id);
    }
    // ONE TOGGLE PER PART, not a +/- pair. This test used to assert the
    // opposite - "one toggle would mean reading two labels to work out what the
    // selection looks like" - and that reasoning was wrong in the one way that
    // mattered: a +/- pair shows NOTHING about the current state, so a
    // selection already showing its side chains looked exactly like one that
    // was not. A toggle carries the state in its own face.
    for (const gone of ['sidechainShowButton', 'sidechainHideButton',
        'mainchainShowButton', 'mainchainHideButton',
        'basesShowButton', 'basesHideButton',
        // ...and the two controls the mode select replaced, plus the row the
        // plate had to itself: three ways to say the same thing was the bug
        'basesShowToggle', 'basesRow', 'backboneShowToggle',
        'elementsShowButton', 'elementsHideButton',
        'contactAddButton', 'contactRemoveButton']) {
        if (html.includes('id="' + gone + '"')) {
            throw new Error(gone + ' is still there - the rows are back to +/- pairs');
        }
    }
    // Elements rides on the SIDE CHAIN row rather than a row of its own: it is
    // a property of the atoms that row draws.
    const scRow = html.indexOf('id="sidechainRow"');
    const scEnd = html.indexOf('</div>', html.indexOf('id="elementsShowToggle"'));
    if (!(html.indexOf('id="elementsShowToggle"') > scRow
        && html.indexOf('id="elementsShowToggle"') < scEnd)) {
        throw new Error('Elements is not on the side-chain row');
    }
    if (html.includes('id="elementsRow"')) {
        throw new Error('the separate Elements row is still there');
    }
    // Each toggle must SAY what it is - the visible text is its accessible
    // name - and carry a title, since "Show" alone does not say show what.
    for (const id of ['sidechainShowToggle', 'elementsShowToggle',
        'mainchainShowToggle', 'contactShowToggle']) {
        const at2 = html.indexOf('id="' + id + '"');
        const open = html.lastIndexOf('<label', at2);
        const close = html.indexOf('</label>', at2);
        const block = html.slice(open, close);
        const text = (block.match(/<span>([^<]*)<\/span>/) || [, ''])[1].trim();
        if (!text) throw new Error(id + ' has no visible label, so it has no name');
        if (!/title="/.test(block.slice(0, block.indexOf('>')))) {
            throw new Error(id + ' has no title - "Show" does not say show what');
        }
    }
    // The colour buttons carry no text - the swatch is the label - so they
    // still need an explicit accessible name.
    for (const id of ['scColorButton', 'selColorButton', 'contactColorButton']) {
        const at2 = html.indexOf('id="' + id + '"');
        const tag = html.slice(html.lastIndexOf('<button', at2), html.indexOf('>', at2));
        if (!/aria-label=/.test(tag)) {
            throw new Error(id + ' has no accessible name');
        }
    }
    const scHide = html.indexOf('id="elementsShowToggle"');
    const mcHide = html.indexOf('id="mainchainShowToggle"');
    const sse = html.indexOf('id="selSsSelect"');
    const copy = html.indexOf('id="copySelectionButton"');
    const del = html.indexOf('id="deleteSelectionButton"');
    if (!(scHide < mcHide && mcHide < sse)) {
        throw new Error('SSE is inside one of the part rows');
    }
    // COPY AND DELETE LIVE IN THE HEAD, above everything else in the panel.
    // Copy used to be a full-width button at the bottom, under the pointer
    // after every other control, and was pressed by accident - which makes a
    // new object each time.
    const head = html.indexOf('class="selection-panel-head"');
    if (!(head >= 0 && head < copy && copy < scHide)) {
        throw new Error('Copy is not in the panel head - at the bottom it sits '
            + 'under the pointer after every other control');
    }
    if (!(copy < del && del < scHide)) {
        throw new Error('Delete is not beside Copy in the head');
    }
});

t('SSE is offered for protein and withheld from nucleic acid', () => {
    // Secondary structure is a protein backbone property: the assignment never
    // gives a nucleotide a letter, so on a DNA or RNA selection this menu
    // offered four states and none of them could do anything.
    const PROT = ['P', 'P', 'P', 'P'];
    const NUC = ['D', 'D', 'D', 'D'];
    const MIX = ['P', 'P', 'D', 'D'];
    if (panelRun([0, 1], new Set(), false, PROT).selSsSelect.hidden !== false) {
        throw new Error('SSE is hidden on a protein selection');
    }
    if (panelRun([0, 1], new Set(), false, NUC).selSsSelect.hidden !== true) {
        throw new Error('SSE is still offered on a nucleic selection, where it does nothing');
    }
    // a mixed selection keeps it: some of what is picked can take a letter
    if (panelRun([0, 2], new Set(), false, MIX).selSsSelect.hidden !== false) {
        throw new Error('SSE went away on a selection that is partly protein');
    }
    if (panelRun(null, new Set(), false, PROT).selSsSelect.hidden !== true) {
        throw new Error('SSE is offered with nothing selected');
    }
});

t('a protein gets a Show toggle, a nucleotide gets the three-way', () => {
    // A protein side chain is drawn or it is not - two states, and a select to
    // pick between two is a menu where a switch would do. Only a nucleotide has
    // the third state. One or the other is on screen, never both.
    const NUC = ['D', 'D'];
    const PROT = ['P', 'P'];
    const prot = panelRun([0, 1], new Set(), false, PROT);
    if (prot.sidechainShowToggle.hidden !== false || prot.sidechainModeSelect.hidden !== true) {
        throw new Error('a protein selection is not offered the plain toggle');
    }
    const nuc = panelRun([0, 1], new Set(), false, NUC);
    if (nuc.sidechainShowToggle.hidden !== true || nuc.sidechainModeSelect.hidden !== false) {
        throw new Error('a nucleic selection is not offered the three-way');
    }
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/setSelectionSidechainMode\(p2, v \? 'full' : 'none'\)/.test(app)) {
        throw new Error('the toggle does not drive the same action as the select');
    }
});

t('a proline closes its ring through the backbone nitrogen', () => {
    // Proline's side chain is a RING, and the atom that closes it is a
    // backbone N. Dropped with the rest of the backbone it draws as a
    // three-atom arm hanging off the CA, which is not what a proline looks
    // like anywhere else - measured on 1UBQ before the fix: CB, CG, CD and
    // nothing joining CD back.
    const utils = fs.readFileSync('web/utils.js', 'utf8');
    const pro = utils.slice(utils.indexOf('    PRO: ['), utils.indexOf('    HYP: ['));
    for (const need of ["\\['CD', 'N'\\]", "\\['N', 'CA'\\]"]) {
        if (!new RegExp(need).test(pro)) {
            throw new Error('the proline ring is open: ' + need + ' is missing');
        }
    }
    // ...which needs the N to still be there, in two places. The table drops
    // every backbone atom but the anchor:
    if (!/const SIDECHAIN_KEEP_BACKBONE = \{ PRO: 'N'/.test(utils)) {
        throw new Error('nothing tells the table to keep proline\'s N');
    }
    if (!/nm0 !== anchorName && nm0 !== keepBB && backboneOf\.has/.test(utils)) {
        throw new Error('the group filter ignores the exception');
    }
    // ...and the CIF parser never builds a standard residue's N at all:
    if (!/SIDECHAIN_KEEP_BACKBONE\[out\[idxResName\]\] !== out\[idxAtomName\]/.test(utils)) {
        throw new Error('the parser still drops proline\'s N, so the table has '
            + 'nothing to keep');
    }
    // ...AND THE RING MEETS THE RIBBON'S FACE. The N sits 1.46 A from the CA,
    // inside a ribbon of any normal width, so the arm that closes the ring ran
    // into the slab and vanished: the pentagon read as a loop diving through
    // the tube. The drawing lifts that ONE atom to the surface, along the same
    // exit the CA-CB bond takes.
    if (!/onBackbone/.test(utils)) throw new Error('the table does not mark the kept atom');
    const revive = utils.slice(utils.indexOf('function reviveSidechainTable'),
        utils.indexOf('function isRealNucleicAcid'));
    const trim = utils.slice(utils.indexOf('function trimSidechainTable'),
        utils.indexOf('function reviveSidechainTable'));
    for (const [where, src] of [['the trim', trim], ['the revive', revive]]) {
        if (!/onBackbone/.test(src)) {
            throw new Error(where + ' drops the flag, and the renderer reads that table');
        }
    }
    const mol2 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (!/bb: \(sc\.onBackbone && sc\.onBackbone\[k\]\) \? 1 : 0/.test(mol2)) {
        throw new Error('the materialised atom does not carry the flag');
    }
    const cart2 = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/if \(!e \|\| !e\.bb\) return v;/.test(cart2)
        || !/const f = ribbonSurfaceToward\(e\.owner, v\);/.test(cart2)) {
        throw new Error('the drawing does not lift the ring onto the ribbon surface');
    }
    // ...and ONLY the drawing moves it: the search and the colour read the atom
    // where it was measured
    if (/\.bb\b/.test(mol2.slice(mol2.indexOf('_atomsOfResidues(want) {'),
        mol2.indexOf('framingPositions(set) {')))) {
        throw new Error('the distance search is using the lifted position');
    }

    // the ring is five atoms round: CA-CB-CG-CD-N-CA, so the table carries
    // three bonds between its own rows and two to the owning position
    const bonds = (pro.match(/\['/g) || []).length;
    if (bonds !== 5) throw new Error('proline has ' + bonds + ' bonds, expected 5');
    // and hydroxyproline is the same ring with an OH on its CG
    if (!/HYP: \[\['CA', 'CB'\]/.test(utils) || !/\['CG', 'OD1'\]/.test(utils)) {
        throw new Error('hydroxyproline did not come with it');
    }
});

t('a nucleotide picks None, Plate or Full from one control', () => {
    // The plate had a row of its own, called "Side chain", next to the row
    // called "Side chains" that draws the real atoms - two controls for one
    // question, and no way to say "one or the other". One select answers it.
    const html = fs.readFileSync('index.html', 'utf8');
    if (html.indexOf('id="basesRow"') >= 0) throw new Error('the plate row is back');
    const at = html.indexOf('id="sidechainModeSelect"');
    if (at < 0) throw new Error('no side-chain mode control');
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/setSelectionSidechainMode\(positions, scMode\.value\)/.test(app)) {
        throw new Error('the mode control is not wired');
    }
    // ...and it means what it says: plate on for the nucleotides, atoms off,
    // and the other way round for full
    const body = app.slice(app.indexOf('function setSelectionSidechainMode'),
        app.indexOf('function syncSelectionVisibility'));
    if (!/setBasesFor\(nuc, mode === 'plate'\)/.test(body)
        || !/setSelectionSidechains\(positions, mode === 'full'\)/.test(body)) {
        throw new Error('the three modes do not drive the two stores');
    }
    // the Plate option is offered only where the selection HAS nucleotides
    const NUC = ['D', 'D'];
    const PROT = ['P', 'P'];
    if (panelRun([0, 1], new Set(), false, NUC).sidechainModeSelect._opts.plate.hidden !== false) {
        throw new Error('Plate is hidden on a nucleic selection');
    }
    if (panelRun([0, 1], new Set(), false, PROT).sidechainModeSelect._opts.plate.hidden !== true) {
        throw new Error('Plate is offered on a protein selection');
    }

    // A BASE IS A SIDE CHAIN, in the table as well as on the panel: the
    // capture takes the base ring plus the two sugar atoms that carry it, so
    // every stick drawn is a real bond - C4' - O4' - C1' - N9/N1 - ring.
    const utils = fs.readFileSync('web/utils.js', 'utf8');
    if (!/sidechainEntries\.push\(\{ pos: newIndex, residue, nucleic: true \}\)/.test(utils)) {
        throw new Error('nucleotides are not offered to the side-chain table');
    }
    if (!/NUCLEIC_BACKBONE_ATOMS/.test(utils) || !/NUCLEIC_SIDECHAIN_BONDS/.test(utils)) {
        throw new Error('the nucleic backbone set or its bond table is gone');
    }
    const tbl = utils.slice(utils.indexOf('const NUCLEIC_SIDECHAIN_BONDS'),
        utils.indexOf('const NUCLEIC_ATOM_ALIASES'));
    for (const need of ["\\[\"C4'\", \"O4'\"\\]", "\\[\"O4'\", \"C1'\"\\]", "'N9', 'C8'", "'C6', 'N1'"]) {
        if (!new RegExp(need).test(tbl)) throw new Error('the base table is missing ' + need);
    }
    if (!/known = e\.nucleic\s*\n?\s*\? NUCLEIC_SIDECHAIN_BONDS/.test(utils)) {
        throw new Error('a base still falls to the distance rule');
    }
    // ...AND THE FRAME IT IS EXPRESSED IN. A nucleic trace steps 5.5-6.5 A and
    // localFrame's default range is the peptide's 3.0-4.2, so every nucleotide
    // read as a chain break and no base could be built at all.
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/NUCLEIC_STEP_MIN = 4\.5/.test(cart) || !/NUCLEIC_STEP_MAX = 7\.5/.test(cart)) {
        throw new Error('the nucleic step range is gone');
    }
    if (!/function localFrame\(at, n, i, out, wrap, stepMin, stepMax\)/.test(cart)) {
        throw new Error('localFrame takes no step range, so it cannot frame a base');
    }
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (!/localFrame\(at, n, i, fr, null, nucLo, nucHi\)/.test(mol)) {
        throw new Error('_materialiseSidechains rebuilds a base through the peptide range');
    }
});

t('Unselect still follows the selection, and lives outside the panel', () => {
    // Select all / Unselect CREATE or clear a selection, so they cannot live in
    // a panel that only exists once there is one - they stay in the sequence
    // header. Unselect still needs a selection to do anything.
    if (panelRun(null).clearAllResidues.disabled !== true) {
        throw new Error('Unselect is enabled with nothing selected');
    }
    if (panelRun([1]).clearAllResidues.disabled !== false) {
        throw new Error('Unselect is disabled with a selection');
    }
    const html = fs.readFileSync('index.html', 'utf8');
    const panelAt = html.indexOf('id="selectionPanel"');
    const globalAt = html.indexOf('id="selectionGlobalTools"');
    const seqAt = html.indexOf('id="sequenceHeader"');
    if (panelAt < 0 || globalAt < 0 || seqAt < 0) throw new Error('markup not found');
    if (globalAt < seqAt) throw new Error('Select all / Unselect left the sequence header');
    if (panelAt > seqAt) throw new Error('the selection panel is not in the right column');
});


// Where a table's atoms actually END UP, so a copy can be judged on the only
// thing that matters: the side chain has to sit where it sat.
function scAtomsOf(frameData, shown) {
    const v = scViewer(shown);
    const built = v._materialiseSidechains(frameData);
    return built.coords.slice(frameData.coords.length);
}
const nearly = (a, b) => Math.abs(a - b) < 1e-6;

t('a copied sub-structure keeps its side chains, renumbered', () => {
    // The table is keyed by POSITION INDEX and a copy renumbers everything, so
    // it can neither be dropped (the copy has no side chains and asking for
    // them does nothing - the reported bug) nor carried across unchanged (its
    // indices would name whichever residues land on those numbers).
    const d = scFixture();
    const v = scViewer([2]);
    // copy residues 1..4, so residue 2 becomes index 1 and its anchor comes too
    const selected = [1, 2, 3, 4];
    const copiedCoords = selected.map((i) => d.coords[i]);
    const out = v._remapSidechains(d.sidechains, selected, d.coords, copiedCoords);
    if (!out) throw new Error('the copy got no side-chain table at all');
    if (out.pos.length !== d.sidechains.pos.length) {
        throw new Error('lost atoms: ' + out.pos.length + ' of ' + d.sidechains.pos.length);
    }
    for (let k = 0; k < out.pos.length; k++) {
        if (out.pos[k] !== 1) throw new Error('atom ' + k + ' points at position '
            + out.pos[k] + ', residue 2 of the original is index 1 of the copy');
        if (out.frameOf[k] !== 1) throw new Error('anchor was not renumbered');
        // The copy can build a frame here from the SAME three residues, so the
        // coefficients come back as they went in - to within the round trip
        // through world axes that the remap now does, which is not bit-exact.
        for (let c = 0; c < 3; c++) {
            if (!nearly(out.coef[k * 3 + c], d.sidechains.coef[k * 3 + c])) {
                throw new Error('coefficients were altered by the copy: '
                    + out.coef[k * 3 + c] + ' vs ' + d.sidechains.coef[k * 3 + c]);
            }
        }
    }
    if (out.bonds.length !== d.sidechains.bonds.length) {
        throw new Error('bonds lost in the copy');
    }
    // and it must actually materialise against the copied coordinates
    const copied = {
        coords: copiedCoords,
        position_types: selected.map(() => 'P'),
        chains: selected.map(() => 'A'),
        position_names: selected.map((i) => d.position_names[i]),
        residue_numbers: selected.map((i) => d.residue_numbers[i]),
        sidechains: out,
    };
    const v2 = scViewer([1]);              // residue 2 is index 1 in the copy
    const built = v2._materialiseSidechains(copied);
    if (built.coords.length !== copied.coords.length + 2) {
        throw new Error('the remapped table did not materialise: '
            + (built.coords.length - copied.coords.length) + ' atoms');
    }
    // and the copy must keep its link to the backbone
    if (!built.bonds.some(([a, b]) => a === 1 || b === 1)) {
        throw new Error('the copied side chain lost its bond to the backbone');
    }
});

t('a copy that leaves the anchor behind drops that side chain, not the table', () => {
    // Coefficients live in the ANCHOR's frame, so without that residue there is
    // no frame to rebuild them in. Dropping the row is honest; re-anchoring to
    // a frame they were never measured against would point the side chain
    // somewhere arbitrary.
    const d = scFixture();
    const v = scViewer([2]);
    const out = v._remapSidechains(d.sidechains, [4, 5],
        d.coords, [4, 5].map((i) => d.coords[i]));      // residue 2 not copied
    if (out !== null) throw new Error('kept rows whose residue was not copied');
    // a table with SOME rows surviving must keep those
    const wide = v._remapSidechains(d.sidechains, [0, 1, 2, 3, 4, 5], d.coords, d.coords);
    if (!wide || wide.pos.length !== d.sidechains.pos.length) {
        throw new Error('a full copy lost rows');
    }
});


t('a copy too short to have a frame still draws its side chain, in place', () => {
    // THE REPORTED BUG. Coefficients live in a LOCAL FRAME built from the
    // residue before and the two after (localFrame's 1 <= i <= n-3 guard), so
    // a copy of one residue can build no frame anywhere and every atom was
    // silently dropped at draw time - the table came across intact and nothing
    // appeared. Measured on 1TIM before the fix: one residue copied gave 3
    // table rows and 0 atoms, four residues gave 11 rows and 4 atoms.
    const d = scFixture();
    const v = scViewer([2]);
    const want = scAtomsOf(d, [2]);          // where they sit in the original
    if (want.length !== 2) throw new Error('fixture drew ' + want.length + ' atoms');

    for (const selected of [[2], [1, 2], [2, 3, 4], [1, 2, 3, 4]]) {
        const copiedCoords = selected.map((i) => d.coords[i]);
        const out = v._remapSidechains(d.sidechains, selected, d.coords, copiedCoords);
        if (!out) throw new Error('copy of ' + JSON.stringify(selected) + ': no table');
        const owner = selected.indexOf(2);
        const copied = {
            coords: copiedCoords,
            position_types: selected.map(() => 'P'),
            chains: selected.map(() => 'A'),
            position_names: selected.map((i) => d.position_names[i]),
            residue_numbers: selected.map((i) => d.residue_numbers[i]),
            sidechains: out,
        };
        const got = scAtomsOf(copied, [owner]);
        if (got.length !== want.length) {
            throw new Error('copy of ' + JSON.stringify(selected) + ' drew '
                + got.length + ' of ' + want.length + ' side-chain atoms');
        }
        for (let k = 0; k < want.length; k++) {
            for (let c = 0; c < 3; c++) {
                if (!nearly(got[k][c], want[k][c])) {
                    throw new Error('copy of ' + JSON.stringify(selected)
                        + ' moved atom ' + k + ': ' + JSON.stringify(got[k])
                        + ' want ' + JSON.stringify(want[k]));
                }
            }
        }
    }
});

t('a gap in the selection does not re-point a side chain at the wrong neighbour', () => {
    // A frame is built from the anchor's NEIGHBOURS. Copy a selection with a
    // hole in it and the residue next door in the copy is a different residue
    // from the one the coefficients were measured against, so carrying them
    // over unchanged would rotate the side chain by whatever the two frames
    // differ by - wrong, and wrong silently.
    const d = scFixture();
    const v = scViewer([2]);
    const want = scAtomsOf(d, [2]);
    const selected = [0, 2, 4];             // 1 and 3 left behind
    const copiedCoords = selected.map((i) => d.coords[i]);
    const out = v._remapSidechains(d.sidechains, selected, d.coords, copiedCoords);
    if (!out) throw new Error('no table');
    const copied = {
        coords: copiedCoords,
        position_types: selected.map(() => 'P'),
        chains: selected.map(() => 'A'),
        position_names: selected.map((i) => d.position_names[i]),
        residue_numbers: selected.map((i) => d.residue_numbers[i]),
        sidechains: out,
    };
    const got = scAtomsOf(copied, [1]);
    if (got.length !== want.length) {
        throw new Error('drew ' + got.length + ' of ' + want.length + ' atoms');
    }
    for (let k = 0; k < want.length; k++) {
        for (let c = 0; c < 3; c++) {
            if (!nearly(got[k][c], want[k][c])) {
                throw new Error('atom ' + k + ' moved to ' + JSON.stringify(got[k])
                    + ', want ' + JSON.stringify(want[k]));
            }
        }
    }
});

t('a side chain follows its residue\'s colour until given one of its own', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const out = v._materialiseSidechains(d);
    const first = d.coords.length;              // first appended atom
    // unset: the atom resolves colour through its OWNER, so recolouring the
    // main chain carries its side chains along
    if (v._colorPositionFor(first) !== 2) {
        throw new Error('an unset side-chain atom does not resolve through its residue');
    }
    if (v._sidechainColorOf(first) !== null) {
        throw new Error('an unset side chain claimed a colour of its own');
    }
    // set: keyed by RESIDUE, because atom indices are reissued every time the
    // set changes and a colour stored against one would come back on another
    v.objectsData.obj.sidechainColor = { 2: '#00ff00' };
    const c = v._sidechainColorOf(first);
    if (!c || c.r !== 0 || c.g !== 255 || c.b !== 0) {
        throw new Error('explicit side-chain colour not resolved: ' + JSON.stringify(c));
    }
    // and it must not leak onto the residue itself
    if (v._sidechainColorOf(2) !== null) {
        throw new Error('the residue picked up its side chain\'s colour');
    }
    if (out.coords.length <= first) throw new Error('fixture did not materialise');
});


// ---- SELECTION HALO ---------------------------------------------------------
// Painted OVER the finished drawing rather than inked into the geometry, so a
// selected residue behind something is still visible - which is the whole
// reason it moved out of the depth sort.
function haloCtx() {
    const ops = [];
    const c = {
        ops, save() { ops.push(['save']); }, restore() { ops.push(['restore']); },
        beginPath() { ops.push(['begin']); },
        moveTo(x, y) { ops.push(['move', x, y]); },
        lineTo(x, y) { ops.push(['line', x, y]); },
        arc(x, y, r) { ops.push(['arc', x, y, r]); },
        stroke() { ops.push(['stroke', c.lineWidth, c.strokeStyle]); },
        fill() { ops.push(['fill', c.fillStyle]); },
        lineJoin: '', lineCap: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
    };
    return c;
}
function haloViewer(sel, n = 8, chains = null) {
    const v = new Cls();
    v.screenFrameId = 7;
    v.screenX = new Float64Array(n); v.screenY = new Float64Array(n);
    v.screenRadius = new Float64Array(n); v.screenValid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        v.screenX[i] = 10 * i; v.screenY[i] = 5; v.screenRadius[i] = 3;
        v.screenValid[i] = 7;
    }
    v.chains = chains || new Array(n).fill('A');
    v.residueSelection = new Set(sel);
    v.sidechainMap = null;
    return v;
}

// decode the recorded path into the index pairs it actually joined
function haloEdges(ctx, v) {
    const at = (x, y) => {
        for (let i = 0; i < v.screenX.length; i++) {
            if (Math.abs(v.screenX[i] - x) < 0.05 && Math.abs(v.screenY[i] - y) < 0.05) return i;
        }
        return -1;
    };
    const out = []; let cur = null;
    for (const o of ctx.ops) {
        if (o[0] === 'move') cur = at(o[1], o[2]);
        else if (o[0] === 'line' && cur >= 0) out.push([cur, at(o[1], o[2])]);
    }
    return out;
}

t('the selection halo is translucent and composited in one stroke', () => {
    const v = haloViewer([2, 3, 4]);
    const ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    const draws = ctx.ops.filter((o) => o[0] === 'stroke' || o[0] === 'fill');
    if (draws.length !== 1) {
        throw new Error('the halo took ' + draws.length + ' draw calls - a '
            + 'translucent colour composites per call, so anything drawn twice '
            + 'darkens where it overlaps and every joint shows as a blot');
    }
    if (!/rgba\(/.test(String(draws[0][2] || draws[0][1]))) {
        throw new Error('the halo is not translucent');
    }
    if (!ctx.ops.some((o) => o[0] === 'save') || !ctx.ops.some((o) => o[0] === 'restore')) {
        throw new Error('canvas state was not saved and restored around the halo');
    }
});

t('the halo joins only what is connected', () => {
    // two runs with a gap between them: nothing may join 3 to 6
    let v = haloViewer([2, 3, 6, 7]);
    let ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    for (const [a, b] of haloEdges(ctx, v)) {
        if (a === b) continue;                       // a dot
        if (Math.abs(a - b) !== 1) {
            throw new Error('the halo joined ' + a + ' to ' + b
                + ', which are not adjacent - the band cut across the residues'
                + ' between two selected stretches');
        }
    }
    // contiguous indices but different chains must not join either
    const chains = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'];
    v = haloViewer([3, 4], 8, chains);
    ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    for (const [a, b] of haloEdges(ctx, v)) {
        if (a !== b && chains[a] !== chains[b]) {
            throw new Error('the halo bridged a chain boundary');
        }
    }
});

t('side chains are joined along their BONDS, not by index order', () => {
    // A side chain is a TREE, and its atoms are appended positions whose index
    // order says nothing about which are bonded. Indices 4..7 are CB, CG, CD1,
    // CD2 of one residue: CG branches, so 6-7 is NOT a bond, and 7 is the last
    // atom of this residue - joining it to 8 by index would run a band into the
    // next residue's side chain through empty space.
    const v = haloViewer([3, 4, 5, 6, 7, 8], 10);
    v.sidechainMap = new Map([[4, { owner: 3 }], [5, { owner: 3 }],
        [6, { owner: 3 }], [7, { owner: 3 }], [8, { owner: 9 }]]);
    v.bonds = [[3, 4], [4, 5], [5, 6], [5, 7]];      // CA-CB-CG, CG branches
    const ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    const got = haloEdges(ctx, v).filter(([a, b]) => a !== b)
        .map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)).sort();
    const want = ['3-4', '4-5', '5-6', '5-7'].sort();
    if (got.join(',') !== want.join(',')) {
        throw new Error('joined ' + JSON.stringify(got) + ', the bonds are '
            + JSON.stringify(want) + ' - index order is not connectivity');
    }
});

t('a selected residue is marked with its side chain', () => {
    // Picking a residue selects ONE position; its atoms are appended positions
    // of their own, so the band stopped at the backbone and the side chain the
    // user was looking at was the one part of the residue left unmarked.
    const v = haloViewer([3], 10);          // only the residue is SELECTED
    v.sidechainMap = new Map([[4, { owner: 3 }], [5, { owner: 3 }],
        [8, { owner: 9 }]]);                 // ...and 8 belongs to someone else
    v.bonds = [[3, 4], [4, 5], [9, 8]];
    const ctx = haloCtx();
    // through the `set` argument, which is how _paintOverlays calls it: the
    // union of the selection and the hover, built from residueSelection and
    // NOT through selectionInk, so the expansion has to happen in the painter
    v._paintSelectionHalo(ctx, 1, new Set([3]));
    const got = haloEdges(ctx, v).filter(([a, b]) => a !== b)
        .map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)).sort();
    if (got.join(',') !== ['3-4', '4-5'].join(',')) {
        throw new Error('marked ' + JSON.stringify(got) + ', expected the residue '
            + 'and its own two atoms');
    }
    // ...and the SELECTION is untouched: Copy, Delete and the panel read that,
    // and they mean the residue
    if (v.residueSelection.size !== 1 || !v.residueSelection.has(3)) {
        throw new Error('marking the side chain changed the selection');
    }
});

t('a lone selected residue still gets a mark, and an unprojected one nothing', () => {
    let ctx = haloCtx();
    const v1 = haloViewer([4]);
    v1._paintSelectionHalo(ctx);
    // drawn as a zero-length segment: with a round cap that is the same circle,
    // but inside the one path and the one stroke
    const dots = haloEdges(ctx, v1).filter(([a, b]) => a === b || b === -1);
    if (!dots.length) throw new Error('a single selected residue drew nothing');
    // not projected this frame
    const v = haloViewer([4]);
    v.screenValid[4] = 0;
    ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    if (ctx.ops.some((o) => o[0] === 'stroke' || o[0] === 'fill')) {
        throw new Error('drew a halo for a residue that was not projected');
    }
    // nothing selected draws nothing at all
    ctx = haloCtx();
    haloViewer([])._paintSelectionHalo(ctx);
    if (ctx.ops.length) throw new Error('drew something with an empty selection');
});

t('the halo is painted after the molecule, in both styles and in exports', () => {
    // it cannot be occluded only if it goes down last - and it has to be inside
    // the render, not on the sequence viewer's DOM overlay, or it would be
    // missing from saved images and skipped during drags
    const src = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    // `this.` prefixed, so the method DEFINITION is not counted as a call -
    // without that this passed with the cartoon branch's call deleted
    const calls = src.split('this._paintOverlays(ctx').length - 1;
    if (calls < 2) throw new Error('the overlays are painted in only ' + calls
        + ' of the two draw paths (cartoon and tube)');
    const cartoonAt = src.indexOf('py2dmolCartoon.render(this, ctx');
    const haloAt = src.indexOf('_paintOverlays(ctx', cartoonAt);
    if (!(haloAt > cartoonAt)) throw new Error('the overlays are painted before the cartoon');
    // ONE PASS FOR EVERYTHING ON TOP. The hover marks used to be a second
    // canvas the sequence viewer painted on its own schedule, which is how they
    // went out of step with the picture underneath. They go down here or not at
    // all: no overlay canvas anywhere, and nothing calling out to one.
    if (!/_paintHoverReadout/.test(src) || !/hoverSet\(\)/.test(src)) {
        throw new Error('the hover is not painted by the renderer');
    }
    for (const f of ['py2Dmol/resources/viewer-mol.js', 'py2Dmol/resources/viewer-seq.js',
        'web/app.js']) {
        const t = fs.readFileSync(f, 'utf8');
        if (/highlightOverlay|drawHighlights/.test(t)) {
            throw new Error(f + ' still refers to the second highlight canvas');
        }
    }
    // and the old in-geometry ink must be gone from both
    if (/const selSet = this\.selectionInk\(\);/.test(src)) {
        throw new Error('tube still inks the selection into the depth-sorted geometry');
    }
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (/const selInk = renderer\.selectionInk/.test(cart)) {
        throw new Error('cartoon still inks the selection into the geometry');
    }
});


// ---- CLIP -----------------------------------------------------------------
//
// PyMOL's clip: a slab in CAMERA space that CUTS the drawing between a near and
// a far plane. Not a selection and not a visibility state - the geometry is cut,
// so a ribbon crossing a plane is drawn up to it and stops.

function clipViewer(pts) {
    const v = new Cls();
    v.coords = pts.map(([x, y, z]) => ({ x, y, z }));
    v.rotatedCoords = pts.map(([x, y, z]) => ({ x, y, z }));
    v._rotPending = false;
    v.render = () => {};
    return v;
}

t('the default slab holds the structure from ANY angle', () => {
    // A slab set from the view's DEPTH EXTENT starts cutting the moment you
    // rotate - a molecule seen end-on is deeper than the same one side-on - and
    // that is what "resetting doesn't recover everything" was. The default is a
    // RADIUS, which is the same number from every angle.
    const pts = [[0, 0, -10], [30, 0, 4], [0, -18, 22]];
    const v = clipViewer(pts);
    const s = v.clipSlabDefault();
    // the worst case: whatever is furthest, turned to point straight at the eye
    let far = 0;
    for (const [x, y, z] of pts) far = Math.max(far, Math.hypot(x, y, z));
    if (s.near < far || s.far > -far) {
        throw new Error('the default slab (' + s.far.toFixed(1) + ' to '
            + s.near.toFixed(1) + ') is tighter than the structure\'s reach of '
            + far.toFixed(1) + ' - a rotation would cut it');
    }
    // ...and it clears the drawn surface, not just the atom centres
    if (s.near <= far) throw new Error('no room for the width the style draws');
});

t('the clip planes cannot cross', () => {
    const v = clipViewer([[0, 0, 0]]);
    v.setClipSlab(-100, 50);          // near behind far
    if (!(v.clipNear > v.clipFar)) {
        throw new Error('near ' + v.clipNear + ' is not in front of far ' + v.clipFar
            + ' - a slab of nothing draws nothing and reads as a bug');
    }
});

t('the slab is a depth test, and off is off', () => {
    const v = clipViewer([[0, 0, 0]]);
    if (!v.clipAccepts(1e6)) throw new Error('with no slab set, nothing is clipped');
    v.setClipSlab(10, -10);
    if (!v.clipAccepts(0)) throw new Error('a point inside the slab was clipped');
    if (v.clipAccepts(11)) throw new Error('a point in front of Near survived');
    if (v.clipAccepts(-11)) throw new Error('a point behind Far survived');
    if (!v.clipAccepts(10) || !v.clipAccepts(-10)) {
        throw new Error('a point exactly on a plane must be kept, as the shader keeps it');
    }
    v.setClipSlab(null, null);
    if (!v.clipAccepts(1e6)) throw new Error('switching the slab off left it clipping');
});

t('Within finds neighbours atom to atom, and keeps the seed', () => {
    // The same question PyMOL answers with byres (all within 5 of sele). It has
    // to be asked of ATOMS: a shell measured between trace points is a list of
    // residues whose CAs are close, and it misses the side chain reaching past
    // them, which is the whole reason anyone asks.
    const v = clipViewer([[0, 0, 0], [4, 0, 0], [9, 0, 0], [20, 0, 0]]);
    const near5 = v.residuesWithin(new Set([0]), 5);
    if (!near5.has(0)) throw new Error('the seed did not come back with the answer');
    if (!near5.has(1) || near5.has(2) || near5.has(3)) {
        throw new Error('the 5 A shell is ' + [...near5].join(',') + ', expected 0,1');
    }
    const near10 = v.residuesWithin(new Set([0]), 10);
    if (!near10.has(2) || near10.has(3)) {
        throw new Error('the 10 A shell is ' + [...near10].join(','));
    }
    // a seed of two takes the union of their shells
    const both = v.residuesWithin(new Set([0, 3]), 5);
    if (!(both.has(0) && both.has(1) && both.has(3)) || both.has(2)) {
        throw new Error('two seeds did not union: ' + [...both].join(','));
    }
    // nonsense in, the selection back out - not an empty one
    if (v.residuesWithin(new Set([0]), 0).size !== 1) throw new Error('zero cutoff grew the selection');
    if (v.residuesWithin(new Set(), 5).size !== 0) throw new Error('an empty seed found something');

    // THE ATOMS ARE REBUILT FOR THE TEST, drawn or not: a side chain is a table
    // of coefficients, and a neighbourhood must not change when someone turns
    // it on. Two passes, or a 300,000-residue assembly rebuilds every side
    // chain to answer a question about twelve of them.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const body = mol.slice(mol.indexOf('residuesWithin(seed, cutoff, opts) {'),
        mol.indexOf('_atomsOfResidues(want) {'));
    if (!/const coarse = cut \+ 2 \* REACH/.test(body)) {
        throw new Error('the first pass does not widen by the side-chain reach, '
            + 'so an atom reaching past its trace point is missed');
    }
    if (!/this\._atomsOfResidues/.test(body)) {
        throw new Error('the exact pass does not use the rebuilt atoms');
    }
    if (!/g\.src !== co \|\| g\.cell !== cell/.test(body)) {
        throw new Error('the grid is rebuilt on every call - 40 ms of a 48 ms '
            + 'search on 3J3Q');
    }
    // and there is a button for it, ON THE SELECTION PANEL: Select all /
    // Unselect / Invert make or clear a selection and take no setting, while
    // this one acts on the selection like every row of the panel - and what you
    // do with the answer is two rows up.
    const html = fs.readFileSync('index.html', 'utf8');
    if (html.indexOf('id="selectNearby"') < 0) throw new Error('no Find control');
    const panelAt = html.indexOf('id="selectionPanel"');
    const toolsAt = html.indexOf('id="selectionGlobalTools"');
    const nearAt = html.indexOf('id="nearbyRow"');
    if (nearAt < 0 || nearAt < panelAt || (toolsAt > 0 && nearAt > toolsAt)) {
        throw new Error('the Within row is not in the selection panel');
    }
    if (html.slice(toolsAt, toolsAt + 900).includes('id="selectNearby"')) {
        throw new Error('Find is still beside Select all');
    }
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/renderer\.residuesWithin\(seed, cutoff, \{ sidechainsOnly \}\)/.test(app)) {
        throw new Error('the button does not ask the renderer');
    }
    if (!/Nothing else within/.test(app)) {
        throw new Error('a search that finds nothing says nothing, so the button reads as dead');
    }
});

t('side chain to side chain is the other question, and leaves the trace out', () => {
    // A backbone runs past everything it folds against, so an any-atom shell
    // around a binding-site residue is half main chain. This asks which
    // residues have their SIDE CHAINS near each other, with the trace atom -
    // the CA, or a nucleotide's C4' - left out of both ends.
    const v = clipViewer([[0, 0, 0], [4, 0, 0], [9, 0, 0]]);
    // no side-chain table: nothing to measure, so nothing is added
    const only = v.residuesWithin(new Set([0]), 5, { sidechainsOnly: true });
    if (only.size !== 1 || !only.has(0)) {
        throw new Error('a structure with no side chains still found neighbours: '
            + [...only].join(','));
    }
    // ...while the any-atom search still finds the trace point beside it
    if (!v.residuesWithin(new Set([0]), 5).has(1)) {
        throw new Error('the any-atom search stopped finding trace neighbours');
    }
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const body = mol.slice(mol.indexOf('residuesWithin(seed, cutoff, opts) {'),
        mol.indexOf('_atomsOfResidues(want) {'));
    // index 0 of each list IS the trace point, so the exclusion is a slice
    if (!/return list\.length > 1 \? list\.slice\(1\) : null;/.test(body)) {
        throw new Error('the trace atom is not being left out');
    }
    // ...EXCEPT A LIGAND, which is all side chain: its heavy atoms are
    // positions of their own, so slicing one off throws away a real atom and a
    // single-atom ligand drops out of the search altogether
    if (!/!scOnly \|\| ptypes\[i\] === 'L'/.test(body)) {
        throw new Error('a ligand loses an atom to the backbone slice');
    }

    // A LIGAND IS SELECTED WHOLE. Each heavy atom is a position, so a side
    // chain reaching one corner of a benzamidine would otherwise select that
    // corner - one atom out of the middle of a molecule nobody asked to take
    // apart. Measured on 3PTB: the seven residues that touch the ligand each
    // bring back all 9 of its atoms, and the four that touch the calcium bring
    // back the 1 that it is.
    const lv = clipViewer([[0, 0, 0], [4.5, 0, 0], [20, 0, 0], [30, 0, 0]]);
    lv.positionTypes = ['P', 'L', 'L', 'P'];
    // residue 0 has one side-chain atom, an Angstrom along x. Anchor -1 means
    // the coefficients are a plain offset from the owner, so this needs no
    // local frame - see _materialiseSidechains.
    lv.sidechains = { pos: Int32Array.from([0]), frameOf: Int32Array.from([-1]),
        coef: Float32Array.from([1, 0, 0]) };
    // ...and the two ligand atoms are ONE ligand, 15 A apart: only the near one
    // is in reach, and the far one has to come with it
    lv.objectsData = { obj: { ligandGroups: new Map([['LIG', [1, 2]]]) } };
    lv.currentObjectName = 'obj';
    const hadExpand = global.expandLigandSelection;
    global.expandLigandSelection = (set, groups) => {
        const out = new Set(set);
        for (const [, members] of groups) {
            if (members.some((i) => out.has(i))) for (const i of members) out.add(i);
        }
        return out;
    };
    try {
        const near = lv.residuesWithin(new Set([0]), 5, { sidechainsOnly: true });
        if (!near.has(1) || !near.has(2)) {
            throw new Error('a ligand came back in pieces: ' + [...near].join(','));
        }
        if (near.has(3)) throw new Error('the search reached past its cutoff');
    } finally {
        if (hadExpand === undefined) delete global.expandLigandSelection;
        else global.expandLigandSelection = hadExpand;
    }
    if (!/if \(!seedAtoms\.length\) return out;/.test(body)) {
        throw new Error('a seed with nothing to measure from is not handled');
    }
    // ONE BUTTON, NO SETTINGS. The distance nobody wanted to change and the
    // choice between "any atom" and "side chain" - whose any-atom half is
    // mostly backbone running past - are both gone: Find interactions is 5 A,
    // side chain to side chain.
    const html = fs.readFileSync('index.html', 'utf8');
    const rowAt = html.indexOf('id="nearbyRow"');
    const row = html.slice(rowAt, html.indexOf('</div>', rowAt));
    if (!row.includes('id="selectNearby"')) throw new Error('the row has no button');
    for (const gone of ['id="selectNearbyA"', 'id="selectNearbySc"', 'selection-row-rule']) {
        if (row.includes(gone)) throw new Error(gone + ' is back - the row has settings again');
    }
    if (!/>interactions</.test(row) || !/selection-panel-label">Find</.test(row)) {
        throw new Error('the row does not read "Find: interactions"');
    }
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/const INTERACTION_CUTOFF_A = 5;/.test(app)) {
        throw new Error('the cutoff is not a named 5 Angstrom');
    }
    if (!/selectNearby\(INTERACTION_CUTOFF_A, true\)/.test(app)) {
        throw new Error('the button does not ask for the side-chain measure at that cutoff');
    }
});

t('the soft edge is a ramp, and half of it is the line picking draws', () => {
    // FADE, THE OTHER WAY TO END A CLIP. Instead of stopping at the plane the
    // drawing thins out over a band outside it, and the band is a FRACTION of
    // the slab's own thickness so the same setting reads the same on a peptide
    // and on a ribosome.
    const v = clipViewer([[0, 0, 0]]);
    v.setClipSlab(10, -10);                 // 20 Angstrom thick
    if (v.clipFadeWidth() !== 0) throw new Error('a new slab starts soft');
    if (v.clipCoverage(11) !== 0) throw new Error('fade 0 is not a hard cut');
    v.setClipFade(0.25);
    if (Math.abs(v.clipFadeWidth() - 5) > 1e-9) {
        throw new Error('a quarter of a 20 Angstrom slab is not ' + v.clipFadeWidth());
    }
    if (v.clipCoverage(0) !== 1 || v.clipCoverage(10) !== 1) {
        throw new Error('the fade ate into the slab itself');
    }
    for (const [z, want] of [[11.25, 0.75], [12.5, 0.5], [13.75, 0.25]]) {
        if (Math.abs(v.clipCoverage(z) - want) > 1e-9) {
            throw new Error('coverage at ' + z + ' is ' + v.clipCoverage(z)
                + ', not the straight ramp ' + want);
        }
    }
    if (v.clipCoverage(15.01) !== 0) throw new Error('the ghost runs past its band');
    if (Math.abs(v.clipCoverage(-12.5) - 0.5) > 1e-9) {
        throw new Error('the far plane got a different ramp from the near one');
    }
    // ...and a click cannot land on a ghost that is more gone than there
    if (!v.clipAccepts(12.4) || v.clipAccepts(12.6)) {
        throw new Error('picking does not cut at half coverage');
    }
    // the fraction is a fraction: out of range is clamped, not obeyed
    v.setClipFade(4);
    if (v.clipFade !== 1) throw new Error('a fade wider than the slab was allowed');
    v.setClipFade(-1);
    if (v.clipFade !== 0) throw new Error('a negative fade was allowed');
    // and with no slab there is nothing to be soft about
    v.setClipSlab(null, null);
    if (v.clipFadeWidth() !== 0) throw new Error('an unclipped view has a fade width');
});

t('the ghost is stippled, not blended, and the shader ramps as the renderer does', () => {
    // A blended fill needs back-to-front order this path does not keep, so a
    // ghost in front of the slab would paint over what should show through it.
    // Dropping pixels needs no order at all.
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const at = gpu.indexOf('const CLIP_GLSL');
    const glsl = gpu.slice(at, gpu.indexOf('`;', at));
    if (!/uClipFade/.test(glsl) || !/clipCover/.test(glsl)) {
        throw new Error('the shader has no soft edge');
    }
    if (!/BAYER\[bi\]/.test(glsl) || !/gl_FragCoord/.test(glsl)
        || !/c < \(BAYER\[bi\] \+ 0\.5\) \/ 16\.0/.test(glsl)) {
        throw new Error('partial coverage is not being dithered - a blended ghost '
            + 'paints over what is behind it');
    }
    // the same ramp on both sides of the wire: 1 + d / width
    if (!/1\.0 \+ d \/ uClipFade/.test(glsl)) {
        throw new Error('the shader ramp is not the renderer ramp');
    }
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (!/1 \+ d \/ w/.test(mol)) throw new Error('the renderer ramp changed shape');
    if (!/uniform1f\(gl\.getUniformLocation\(prog, 'uClipFade'\)/.test(gpu)) {
        throw new Error('the fade never reaches the shader');
    }
    if (!/renderer\.clipFadeWidth \? renderer\.clipFadeWidth\(\) : 0/.test(gpu)) {
        throw new Error('the GPU path does not read the fade off the renderer');
    }
    // it rides with the object, like the planes
    if (!/clipFade: this\.clipFade/.test(mol) || !/saved\.clipFade/.test(mol)) {
        throw new Error('the fade does not travel with the object');
    }
    // ...and there is a control for it
    const html = fs.readFileSync('index.html', 'utf8');
    if (html.indexOf('id="clipFadeSlider"') < 0) throw new Error('no Fade control');
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/setClipFade\(parseFloat\(fadeEl\.value\) \/ 100\)/.test(app)) {
        throw new Error('the Fade control is not wired to the renderer');
    }
    // the control is a percentage, the renderer a fraction, and a tenth is
    // where it starts
    if (!/id="clipFadeSlider" min="0" max="100" value="10"/.test(html)) {
        throw new Error('the Fade control is not a percentage starting at 10');
    }
    if (!/const CLIP_FADE_DEFAULT = 0\.1;/.test(mol)) {
        throw new Error('the renderer default fade moved');
    }
    // A SOFT EDGE NEEDS AN EDGE. Clip opens with the planes parked at the rest
    // state, where nothing is outside the slab - drag Fade there and the
    // picture cannot change, which reads as a broken control. It is disabled
    // until a plane is actually cutting, and re-checked on every knob move.
    if (!/function clipCuts\(\)/.test(app) || !/function syncFadeEnabled\(\)/.test(app)) {
        throw new Error('Fade is offered even where it can do nothing');
    }
    const cuts = app.slice(app.indexOf('function clipCuts()'),
        app.indexOf('function syncFadeEnabled()'));
    if (!/clipNear < view\.near/.test(cuts) || !/clipFar > view\.far/.test(cuts)) {
        throw new Error('"is anything being cut" is not measured against the view');
    }
    const pushAt = app.indexOf('const push = () => {');
    const pushBody = app.slice(pushAt, app.indexOf('\n    };', pushAt));
    if (!/syncFadeEnabled\(\)/.test(pushBody)) {
        throw new Error('moving a knob does not re-check whether Fade can act');
    }
});

t('the clip is one range control, and nothing is drawn over the picture', () => {
    // The box round the planes is gone: it was one more thing to read in the
    // viewport, and the two handles already say where the slab is.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (/_paintClipSlab|CLIP_NEAR_CSS/.test(mol)) {
        throw new Error('the clip still paints a box over the drawing');
    }
    const html = fs.readFileSync('index.html', 'utf8');
    // ONE track, TWO handles, which the CSS has to put on top of each other -
    // two separate sliders is what was confusing.
    const panel = html.slice(html.indexOf('id="clipPanel"'),
        html.indexOf('id="styleAppearanceContainer"'));
    for (const id of ['clipFar', 'clipNear', 'clipResetButton']) {
        if (!panel.includes('id="' + id + '"')) {
            throw new Error('the clip panel has no ' + id);
        }
    }
    if (!/#clipRange input\[type=range\][^}]*position: absolute/.test(html)) {
        throw new Error('the two handles are not on one track');
    }
});

t('a clip cuts the ink with the fills, and double-click still takes the chain', () => {
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    // THE 2D INK IS COLLECTED SEPARATELY FROM THE FILLS. The prim cull never
    // saw these curves, so a slab left the outline of everything it had cut
    // away drawn over empty paper - measured on 1TIM, 53,296 drawn pixels
    // against the GPU's 42,520, and the excess was all wire.
    if (!/const inSlab = \(s\) =>/.test(cart)
        || !/visible = okAt\(s\) && onCanvas\(s\) && inSlab\(s\)/.test(cart)) {
        throw new Error('the 2D ink pass does not ask the clip');
    }
    if (!/clipAccepts\(\(pts\[s\]\[2\] \+ pts\[s \+ 1\]\[2\]\) \/ 2\)/.test(cart)) {
        throw new Error('the ink is not cut on its own depth, so it cannot '
            + 'follow a soft edge');
    }
    // A DOUBLE CLICK IS A BULK OPERATION ON A NAME. The pick that precedes it
    // still has to land on something visible; the chain it widens to does not
    // stop at the near plane.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('for (let k = 0; k < this.chains.length; k++) {');
    if (at < 0) throw new Error('the dblclick chain union moved');
    const body = mol.slice(at, mol.indexOf('}', mol.indexOf('next.add(k)', at)));
    if (/_pickable/.test(body)) {
        throw new Error('double-click drops the clipped part of the chain');
    }
    // ...while the single click still refuses what the slab cut
    if (!/_pickable\(i\)|return !c \|\| this\.clipAccepts\(c\.z\)/.test(mol)) {
        throw new Error('_pickable is gone, so a click can land on a cut residue');
    }
});

t('hiding a base rebuilds the GPU mesh, because a plate is geometry', () => {
    // A base plate is built from the ribbon frame, not from a position, so
    // hiding one moves NOTHING else the signature was watching - not the
    // coordinate count, not the segment list, not the visibility mask. The
    // mesh was reused and the GPU went on drawing the plate: measured on 1BNA,
    // 64,454 drawn pixels with the bases hidden and 64,454 with them shown,
    // against the 2D pass's 50,030.
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const at = gpu.indexOf('function signatureOf(');
    const sig = gpu.slice(at, gpu.indexOf('\n}', at));
    if (!/o && o\.bases \? 'b' \+ idOf\(o\.bases\)/.test(sig)) {
        throw new Error('the mesh signature does not name the base set');
    }
    if (!/cartoonBasePlates === false \? 'noplates'/.test(sig)) {
        throw new Error('the plates switch is not in the signature either');
    }
    // ...and the 2D pass is what it has to agree with
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/const baseShown = \(res\) => !baseSet \|\| baseSet\.has\(res\)/.test(cart)) {
        throw new Error('the 2D pass no longer decides plates per residue');
    }
});

t('the backbone hides per selection, and the side chains keep their CA', () => {
    // Hiding a RESIDUE takes its side chain with it. This is the other cut:
    // the fold goes and the side chains stay, which is how you look at a
    // binding site without the backbone in front of it. Per residue and per
    // object, beside `sidechains` and `bases` - a global switch was the first
    // shape of this and it is not what anyone wants to reach for.
    const v = clipViewer([[0, 0, 0], [3, 0, 0], [6, 0, 0]]);
    v.objectsData = { obj: {} };
    v.currentObjectName = 'obj';
    if (v.backboneHiddenSet()) throw new Error('something starts hidden');
    if (!v.setBackboneHiddenFor([1], true)) throw new Error('hiding changed nothing');
    if (!v.backboneHiddenAt(1) || v.backboneHiddenAt(0)) {
        throw new Error('the wrong residues are hidden');
    }
    if (v.setBackboneHiddenFor([1], true)) {
        throw new Error('hiding what is already hidden asks for a redraw');
    }
    // a NEW set each time, or the mesh signatures compare it by identity and
    // never see the change
    const first = v.objectsData.obj.hiddenBackbone;
    v.setBackboneHiddenFor([2], true);
    if (v.objectsData.obj.hiddenBackbone === first) {
        throw new Error('the set is edited in place, so the GPU will not rebuild');
    }
    v.setBackboneHiddenFor([1, 2], false);
    if (v.backboneHiddenSet()) throw new Error('showing again left the set behind');

    // WHAT COUNTS AS SIDE CHAIN. One endpoint in the map is enough - that is
    // what keeps the CA-CB bond, whose CA is a base position - and a contact
    // is an annotation, not backbone.
    v.sidechainMap = new Map([[7, { owner: 1 }], [8, { owner: 1 }]]);
    if (!v._isSidechainSegment({ idx1: 1, idx2: 7 })) {
        throw new Error('the CA-CB bond reads as backbone, so a hidden backbone '
            + 'cuts the side chain off the residue it belongs to');
    }
    if (!v._isSidechainSegment({ idx1: 7, idx2: 8 })) throw new Error('an atom-atom bond is not side chain');
    if (v._isSidechainSegment({ idx1: 0, idx2: 1 })) throw new Error('a backbone segment counts as side chain');
    if (!v._isSidechainSegment({ type: 'C', idx1: 0, idx2: 2 })) {
        throw new Error('a contact is being treated as backbone');
    }

    // every draw path asks it, on BOTH endpoints - so the cut lands at the
    // edge of the selection rather than a residue short of it
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/bbHidden\.has\(segInfo\.idx1\) && bbHidden\.has\(segInfo\.idx2\)/.test(mol)) {
        throw new Error('the 2D tube path draws the backbone regardless');
    }
    if (!/noBB\.has\(s\.idx1\) && noBB\.has\(s\.idx2\)/.test(mol)) {
        throw new Error('the GPU tube path ignores the switch');
    }
    if (!/const bbHide = renderer\.backboneHiddenSet/.test(cart)
        || !/isBackbonePrim\(g\.kind\) && bbHide\.has\(resOf\(g\)\)/.test(cart)) {
        throw new Error('the 2D cartoon draws the backbone regardless');
    }
    // ...INCLUDING THE INK, which is collected somewhere else entirely - the
    // same trap the clip fell into: the prims went and the outline stayed.
    if (!/bb: isBackbone \? 1 : 0/.test(cart) || !/bbHideInk && cv\.bb/.test(cart)) {
        throw new Error('the 2D outline is not tagged by class, so hiding the '
            + 'backbone leaves its outline drawn over empty paper');
    }
    // the GPU cartoon needs no shader for it - the capture takes what the 2D
    // pass builds - but the signature has to notice
    if (!/o && o\.hiddenBackbone \? 'nb' \+ idOf\(o\.hiddenBackbone\)/.test(gpu)) {
        throw new Error('the cartoon mesh signature does not name the hidden set');
    }
    if (!/backboneHiddenSet\(\)\s*\n?\s*\? 'nobb'/.test(gpu)) {
        throw new Error('the tube mesh signature does not name the hidden set');
    }
    // and it lives on the selection panel, travels with a Copy, and is saved
    const html = fs.readFileSync('index.html', 'utf8');
    const app = fs.readFileSync('web/app.js', 'utf8');
    // MAIN CHAIN'S "Show" IS THE BACKBONE. It used to hide the whole residue,
    // with a second toggle beside it for the chain alone - two controls where
    // one says "draw this part", which is what Show means on every other row.
    if (html.indexOf('id="mainchainShowToggle"') < 0) throw new Error('no Show toggle');
    if (html.indexOf('id="backboneCheckbox"') >= 0) {
        throw new Error('the global Backbone button is back');
    }
    if (!/setSelectionBackbone\(p2, v\)/.test(app)) throw new Error('the toggle is not wired');
    // ...and a residue with no part drawn drops out of the visibility mask, so
    // Orient, the clip and picking still agree with the picture
    if (!/function syncSelectionVisibility/.test(app)
        || !/const drawsSomething = \(i\) =>/.test(app)) {
        throw new Error('nothing composes visibility from the parts');
    }
    if (!/'sidechains', 'elements', 'bases', 'hiddenBackbone'/.test(mol)) {
        throw new Error('a Copy loses which backbones were hidden');
    }
    if (!/objToSave\.hidden_backbone/.test(app) || !/objData\.hidden_backbone/.test(app)) {
        throw new Error('the session does not carry the hidden backbone');
    }
});

t('framing a residue uses its atoms, not its trace point', () => {
    // A residue is ONE position here, so orienting on one framed a single
    // point: the camera pointed at a CA with the side chain hanging off it.
    // Its atoms are positions whenever the side chain is drawn.
    const v = clipViewer([[0, 0, 0], [3, 0, 0], [6, 0, 0], [3, 1.5, 0], [3, 3, 0]]);
    v.objectsData = { obj: {} };
    v.currentObjectName = 'obj';
    v.sidechainMap = new Map([[3, { owner: 1 }], [4, { owner: 1 }]]);
    const framed = v.framingPositions(new Set([1]));
    if (framed.size !== 3 || !framed.has(3) || !framed.has(4)) {
        throw new Error('the side-chain atoms are not framed with their residue: '
            + [...framed].join(','));
    }
    // ...and the selection itself is untouched - Copy, Delete and the panel
    // all read that, and they mean the residue
    const sel = new Set([1]);
    v.framingPositions(sel);
    if (sel.size !== 1) throw new Error('framing edited the selection');
    // nothing hidden is framed
    v.visiblePositions = new Set([1, 3]);
    const vis = v.framingPositions(new Set([1]));
    if (vis.has(4)) throw new Error('a hidden atom was framed');
    // an unrelated residue picks up nothing
    v.visiblePositions = null;
    if (v.framingPositions(new Set([2])).size !== 1) {
        throw new Error('framing added atoms that belong to another residue');
    }
    // the orient path asks for it, and reads the LIVE coordinates - the
    // appended atoms sit past the end of the stored frame's array
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/renderer\.framingPositions\(selectedPositionIndices\)/.test(app)) {
        throw new Error('Orient still frames on one point per residue');
    }
    if (!/const liveCoords = \(renderer\.coords/.test(app)) {
        throw new Error('Orient reads the stored frame, which has no side-chain '
            + 'atoms in it, so the expansion does nothing');
    }
});

t('the clip cuts the drawing, it does not touch visibility', () => {
    // The whole reason this moved out of the mask: clipping is a camera state,
    // and writing it into visibility made it a per-object edit that had to be
    // committed, frozen against a view, and undone.
    const v = clipViewer([[0, 0, 0], [0, 0, 100]]);
    let touched = false;
    v.setVisibility = () => { touched = true; };
    v.setClipSlab(10, -10);
    if (touched) throw new Error('setClipSlab wrote to the visibility mask');
    if (v.visiblePositions) throw new Error('the clip hid a position');
});

t('no clip code path touches visibility', () => {
    // The clip used to commit itself into the visibility mask, and a mask
    // outlives the control that wrote it: residues stayed hidden after the slab
    // was reset, and only Show all brought them back. Clipping is a camera
    // state - it may not write to the thing that hides residues.
    const both = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8')
        + fs.readFileSync('web/app.js', 'utf8');
    // every line mentioning clip, and none of them may also mention the mask
    for (const line of both.split('\n')) {
        if (!/\bclip/i.test(line)) continue;
        if (/setVisibility|visiblePositions|visibilityMode/.test(line)) {
            throw new Error('a clip line writes visibility: ' + line.trim());
        }
    }
    // ...and the two functions that own the slab must not reach it either
    const m = src.match(/\n        setClipSlab\(near, far\) \{[\s\S]*?\n        \}/);
    if (!m) throw new Error('setClipSlab is gone');
    if (/setVisibility|visiblePositions/.test(m[0])) {
        throw new Error('setClipSlab writes visibility');
    }
});

t('the clip track measures the view, the rest state measures the object', () => {
    // Two different numbers, deliberately. The TRACK is the structure's depth
    // in this view, so moving a knob cuts something straight away - padded, it
    // spent the first 6 Angstrom of a 36 Angstrom structure doing nothing. The
    // REST STATE is a radius, so parking a knob at the end cuts nothing however
    // the structure is then turned. The ends mean off; app.js stores the rest
    // state for a knob within one step of its limit.
    const v = clipViewer([[0, 0, -10], [30, 0, 4], [0, -18, 22]]);
    v.lineWidth = 3;
    const view = v.clipViewExtent();
    const rest = v.clipSlabDefault();
    if (view.near !== 22 || view.far !== -10) {
        throw new Error('the track is not the view depth: ' + JSON.stringify(view));
    }
    if (!(rest.near > view.near)) {
        throw new Error('the rest state does not reach past the view - a knob '
            + 'parked at the end would cut as soon as the structure turned');
    }
    const app = fs.readFileSync('web/app.js', 'utf8');
    const at = app.indexOf('WITHIN ONE STEP OF THE END IS AT THE END');
    if (at < 0) throw new Error('the end-of-track rule is gone');
    const block = app.slice(at, at + 700);
    if (!/rest\.near/.test(block) || !/rest\.far/.test(block)) {
        throw new Error('a knob at the end no longer stores the rest state');
    }
    // ...and a new object has to re-range the panel: loading one does not go
    // through the object dropdown
    if (!/syncClipPanelToObject/.test(app.slice(app.indexOf('dropToTubeIfCartoonWontFit(r);'),
        app.indexOf('dropToTubeIfCartoonWontFit(r);') + 300))) {
        throw new Error('loading an object does not refresh the clip panel');
    }
});

t('the clip is per object, and the capture ignores it', () => {
    // A slab is Angstrom along the camera's depth and objects differ in size by
    // orders of magnitude, so it rides with the per-object view state rather
    // than staying on screen when you switch.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('_switchToObject(newObjectName) {');
    const body = mol.slice(at, mol.indexOf('\n        _exitOverlayMode', at));
    if (!/clipNear: this\.clipNear/.test(body) || !/this\.clipNear = \(typeof saved\.clipNear/.test(body)) {
        throw new Error('the clip no longer travels with the object - switching '
            + 'would leave one structure wearing another\'s slab');
    }
    // ...AND THE MESH IS CAPTURED WITHOUT IT. The 2D pass cannot cut a
    // primitive, only drop it, so a mesh harvested under a slab is missing
    // every piece that straddles a plane - measured 40,617 ink pixels against
    // 41,520 for the same slab over a complete mesh.
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const cap = gpu.slice(gpu.indexOf('const keep = {'), gpu.indexOf('const keep = {') + 2500);
    if (!/renderer\.clipNear = null/.test(cap)) {
        throw new Error('captureFrom harvests the mesh through the clip');
    }
    if (!/renderer\.clipNear = keep\.clipNear/.test(gpu)) {
        throw new Error('captureFrom does not put the clip back');
    }
});

t('every draw path asks the same clip test', () => {
    // Four paths draw: 2D tube, 2D cartoon, and both GPU programs. The two
    // canvas paths cull whole primitives by depth (a canvas cannot cut one);
    // the GPU cuts per fragment. They must at least be reading the same slab.
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/clipped\(vZv\)/.test(gpu) || !/clipped\(zSurf\)/.test(gpu)) {
        throw new Error('a GPU program draws without the clip test - the ribbon '
            + 'and the tube must both be cut');
    }
    if (!/setClipSlab\(renderer\.clipSlabOn/.test(gpu)) {
        throw new Error('the GPU never reads the slab off the renderer');
    }
    if (!/renderer\.clipAccepts/.test(cart)) {
        throw new Error('the 2D cartoon path ignores the slab');
    }
    if (!/clipCull && !this\.clipAccepts\(zValues\[idx\]\)/.test(src)) {
        throw new Error('the 2D tube path ignores the slab');
    }
    // ...and it culls at the PAINT, not in the order it projects from: a
    // position with no screen coordinates carries no selection band, and the
    // band has to show where the selection is even where the slab cut it away.
    if (/visibleOrder = visibleOrder\.filter/.test(src)) {
        throw new Error('the clip is culling the projection order again - the '
            + 'selection band vanishes with the geometry');
    }
});

// YIELDING IS NOT FREE. A setTimeout is clamped to about 4 ms whatever you ask
// for, so handing the browser a turn only pays where the work between turns is
// longer than that. Yielded per STEP, a 275-model simulation - 0.1 ms of work a
// model - spent 30 ms of clamped timers per model and took 8.3 seconds to load
// 39 positions. Yielded on TIME, the same file takes 164 ms.
t('a load yields on time, not on steps', () => {
    const u = fs.readFileSync('web/utils.js', 'utf8');
    if (!/function yieldIfBusy/.test(u)) {
        throw new Error('yieldIfBusy is gone - loads are yielding per step again');
    }
    const body = u.slice(u.indexOf('function yieldIfBusy'), u.indexOf('function yieldIfBusy') + 700);
    if (!/YIELD_EVERY_MS/.test(body)) throw new Error('the yield has no time budget');
    // the drainers and the loader loop must all use it: any one left on the
    // unconditional yield is a per-step timer again
    for (const [file, want] of [['web/utils.js', 2], ['web/app.js', 2]]) {
        const src2 = fs.readFileSync(file, 'utf8');
        const n = (src2.match(/await yieldIfBusy\(\)/g) || []).length;
        if (n < want) {
            throw new Error(file + ' has ' + n + ' time-budgeted yields, expected '
                + want + ' - a step-yield is back in the load path');
        }
    }
    // ...and the per-model loop must not hold an unconditional one
    const app = fs.readFileSync('web/app.js', 'utf8');
    const loop = app.slice(app.indexOf('for (let i = 0; i < models.length'),
        app.indexOf('rawFrames.push(frameObj)'));
    if (/await yieldToBrowser\(\)/.test(loop)) {
        throw new Error('the per-model loop yields unconditionally - that is 4 ms '
            + 'a model, and a simulation is thousands of models');
    }
});

// A RIBBON AT THICKNESS 0 STILL HAS AN OUTLINE.
//
// With no thickness a piece has no outward direction, so the GPU carries it as
// one double-sided face - and the silhouette rule needs two faces to compare,
// so the edge table came out with no boundary edges and no creases: 3,422 edges
// against 6,988, and a drawing with almost no lines on it. A twentieth of an
// Angstrom makes each piece a closed solid and the rule works by construction.
t('the ribbon keeps its outline at zero thickness', () => {
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const m = gpu.match(/const GPU_RIBBON_THICK = ([0-9.]+);/);
    if (!m) throw new Error('GPU_RIBBON_THICK is gone');
    const v = parseFloat(m[1]);
    if (!(v > 0)) {
        throw new Error('the ribbon thickness floor is ' + v + ' - at 0 the GPU '
            + 'draws the ribbon preset with no outline at all (1,049 dark pixels '
            + 'against the 2D pass\'s 14,789)');
    }
    if (v > 0.2) {
        throw new Error('the floor is ' + v + ' - past about 0.2 the ribbon stops '
            + 'reading as flat: 1.07x the 2D pass\'s ink and climbing');
    }
    // ...and it is applied at CAPTURE, where the mesh is built, not at draw
    const capAt = gpu.indexOf('GIVE THE FLAT PIECES A REAL THICKNESS');
    const cap = gpu.slice(capAt, capAt + 2200);
    if (!/renderer\.cartoonThickness = Math\.max\(renderer\.cartoonThickness \|\| 0, ribThick\)/.test(cap)) {
        throw new Error('the floor is no longer applied to the capture');
    }
});

// A SELECTION IS MARKED WHETHER OR NOT IT IS DRAWN.
//
// The band is a UI indicator - the reason it is not depth-sorted is that it has
// to say where the selection IS. Hiding those residues, or clipping them away,
// takes the geometry and must leave the mark, over nothing if that is what is
// there. All four projections have to agree about it: the two 2D paths, the
// picking projection, and the GPU's.
t('a hidden or clipped selection is still marked', () => {
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    // picking projection
    if (!/const wanted = \(i\) => !mask \|\| mask\.has\(i\) \|\| \(marked && marked\.has\(i\)\)/.test(mol)) {
        throw new Error('_projectForPicking drops hidden positions, band and all');
    }
    // the 2D tube path
    if (!/for \(const i of markedSel\)/.test(mol)) {
        throw new Error('the 2D tube path does not project a hidden selection');
    }
    // the 2D cartoon path
    if (!/if \(!vis\(i\) && !\(marked && marked\.has\(i\)\)\)/.test(cart)) {
        throw new Error('the 2D cartoon path does not project a hidden selection');
    }
    // and the GPU's
    if (!/\|\| !!\(marked && marked\.has\(i\)\)/.test(gpu)) {
        throw new Error('the GPU path does not project a hidden selection');
    }
});

// DRAW IS A 2D EFFECT AND HAS TO GET A 2D FRAME.
//
// The build-up is three layers in an illustrator's order, revealed along the
// chain by a pen whose pace follows the local curvature, and every bit of it is
// canvas compositing in viewer-cartoon.js. The GPU knows nothing about it: with
// the GPU on it drew the finished picture while the animation ran invisibly -
// measured 33% of the way through, the canvas held 99.5% of the finished ink
// against 31% on the 2D path. The GPU is the default on this page, so that was
// most people's Draw.
t('Capture draws on the GPU too, at the size it is exporting', () => {
    // CAPTURE USED TO BE THE 2D DRAWING, ALWAYS. saveImage renders into a
    // canvas of its own, and both GPU entries refused any canvas that was not
    // the screen's - so the picture you exported was made by a different
    // renderer from the one you were looking at.
    const v = clipViewer([[0, 0, 0]]);
    v.useGPU = true;
    v.drawMode = false;
    // the class closed over global.window when it was built, so the stubs have
    // to be PUT ON that object and taken off again - swapping the object does
    // nothing, and leaving them on tells every later test the GPU is present
    const had = { g: window.py2dmolCartoonGPU, c: window.py2dmolCartoon };
    window.py2dmolCartoonGPU = { render: () => true, renderTube: () => true };
    window.py2dmolCartoon = {};
    if (!v.canvas) v.canvas = mkCanvas(600, 600);
    try {
        const canvasCtx = (cv) => ({ canvas: cv, drawImage: () => {} });
        const screen = canvasCtx(v.canvas);
        const exportCv = canvasCtx({ width: 1869, height: 1869 });
        if (!v._gpuWillTake(screen)) throw new Error('the GPU stopped taking the screen');
        if (!v._gpuWillTake(exportCv)) {
            throw new Error('an export canvas is still refused - Capture is back on the 2D path');
        }
        // an SVG context is a different matter: there is no vector in a raster
        const svg = { canvas: {width: 10, height: 10}, drawImage: () => {},
            getSerializedSvg: () => '' };
        if (v._gpuWillTake(svg)) throw new Error('the GPU offered to draw an SVG export');
        v.drawMode = true;
        if (v._gpuWillTake(exportCv)) throw new Error('Draw stopped taking the 2D path');
    } finally {
        if (had.g === undefined) delete window.py2dmolCartoonGPU;
        else window.py2dmolCartoonGPU = had.g;
        if (had.c === undefined) delete window.py2dmolCartoon;
        else window.py2dmolCartoon = had.c;
    }

    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (/ctx\.canvas !== renderer\.canvas/.test(gpu)
        || /ctx\.canvas !== this\.canvas/.test(mol)) {
        throw new Error('a draw path still insists on the screen canvas');
    }
    // AT THE EXPORT'S SIZE, NOT THE SCREEN'S, and only once. Both scales were
    // wrong in the same way first: the cartoon multiplied _exportPxScale into
    // the pixel ratio on top of a mesh captured at the export size, and the
    // tube measured its ratio against renderer.displayWidth. Both drew the
    // structure three times too large at 300 dpi.
    if (/setPixelRatio\([^;]*_exportPxScale/.test(gpu)) {
        throw new Error('the cartoon counts the export scale twice');
    }
    const dt = gpu.slice(gpu.indexOf('function drawTube(cv, renderer, prm) {'),
        gpu.indexOf('const ratio = dw > 0'));
    if (!/prm\.displayWidth/.test(dt)) {
        throw new Error('the tube scales an export against the screen size');
    }
    // AND A BUFFER THE DRIVER WILL NOT MAKE THAT BIG IS NOT A PICTURE. A canvas
    // over the limit is CLAMPED silently, so the blit would scale a small
    // drawing up; measured headless, a 7,475 px export came back as 5,760.
    if (!/function bufferFits\(w, h\)/.test(gpu)
        || (gpu.match(/if \(!bufferFits\(w, h\)\) return false;/g) || []).length < 2) {
        throw new Error('an oversized export is not handed back to the 2D path');
    }
    // AND THE INK IS A NUMBER OF PIXELS. The mesh is captured at the export's
    // size so the geometry carries k already, but the outline width does not -
    // left at the display value a 300 dpi export drew it four times too thin,
    // measured as 45.7 dark pixels per 10k against the 2D export's 103.2.
    if (!/\* \(r\._exportPxScale \|\| 1\)/.test(gpu)) {
        throw new Error('the cartoon outline does not follow the export scale');
    }
    // ...and a transparent export must stay transparent: the GPU clears to
    // paper, which would put an opaque square under the drawing
    if ((gpu.match(/setClearAlpha\(renderer\.isTransparent \? 0 : 1\)/g) || []).length < 2) {
        throw new Error('a GPU export paints its own background over the transparency');
    }
});

t('Draw takes the 2D path, whatever the GPU setting says', () => {
    const src2 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = src2.indexOf('const gpuOk = this.useGPU === true');
    if (at < 0) throw new Error('the cartoon GPU gate moved');
    const gate = src2.slice(at, at + 260);
    if (!/!this\.drawMode/.test(gate)) {
        throw new Error('the cartoon GPU gate ignores Draw, so the build-up runs '
            + 'invisibly under a finished picture');
    }
    // ...and the decision the rest of the frame makes about which path will
    // draw has to agree, or inertia and the segment floor are answered for the
    // wrong renderer
    const willDraw = src2.slice(src2.indexOf('_gpuWillDraw() {'), src2.indexOf('_gpuWillDraw() {') + 300);
    if (!/this\.drawMode/.test(willDraw)) {
        throw new Error('_gpuWillDraw does not know about Draw');
    }
});

// ONE OCCLUSION PASS, TWO STYLES. FSAO reads a field of view depths and knows
// nothing about what drew it, so the cartoon needs no shader of its own - only
// its own constants. What it does need is for the pass to keep its hands off
// the texture units its caller is using: run on units 0 and 1 it left the depth
// field where the fill program's visibility map should be and the raw occlusion
// where its palette should be, and half the drawing came out white.
t('a zero-thickness ribbon picks its side per PIECE, as the reference does', () => {
    // Both faces of a flat helix sit at the same depth, so one of them has to
    // be culled or they fight. WHICH one is the question this settles: the 2D
    // pass paints both back to front keyed on the piece mean, so a fold comes
    // out as a clean edge, and the GPU used the per-station normal instead -
    // which flips sides part-way through a piece and puts the pale inner face
    // through the outer one as a wedge (6MRR).
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const at = gpu.indexOf('if (aSheet > 0.5) {');
    if (at < 0) throw new Error('the zero-thickness side test is gone');
    const branch = gpu.slice(at, at + 300);
    if (!/oBcull = dot\(normalize\(uRot \* aFlatShade\), vd\)/.test(branch)) {
        throw new Error('the side test no longer reads the piece mean');
    }
    if (/oBcull = dot\(ubTrue/.test(branch)) {
        throw new Error('the side test is back on the interpolated normal');
    }
    // aFlatShade IS the piece mean for a broad face, and this branch only sees
    // broad faces - a side band is never marked thin
    if (!/const nFlat = isRibFace \? \(\(pf && pf\.nMean\)/.test(gpu)) {
        throw new Error('aFlatShade is no longer the piece mean');
    }
    if (!/sheetA: \(!isSide && thinAt\[k\]\)/.test(gpu)) {
        throw new Error('a side band can now be marked thin, and the piece mean '
            + 'is the wrong vector for one');
    }
});

t('the occlusion pass is shared, and stays off the low texture units', () => {
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const at = gpu.indexOf('function runOcclusion(cv, o) {');
    if (at < 0) throw new Error('runOcclusion is gone - the tube and the cartoon '
        + 'have two copies of the occlusion again');
    const body = gpu.slice(at, gpu.indexOf('\nfunction ', at + 10));
    for (const unit of ['TEXTURE0', 'TEXTURE1']) {
        if (body.includes('gl.activeTexture(gl.' + unit + ')')) {
            throw new Error('runOcclusion binds ' + unit + ', which its callers are using');
        }
    }
    // ...and both callers ask it, rather than one of them inlining it
    const calls = (gpu.match(/runOcclusion\(cv/g) || []).length;
    if (calls < 2) throw new Error('only ' + calls + ' caller uses the shared pass');
    // the cartoon's AO is off unless asked for: the 2D path has no occlusion to
    // match, so leaving it on would make the GPU switch change the drawing
    if (!/renderer\.cartoonAO === true/.test(gpu)) {
        throw new Error('the cartoon occlusion is no longer behind its flag');
    }
    // ...AND THE ALLOCATION MUST GIVE THE UNIT BACK. ensureOcc binds every
    // texture it creates to whatever unit is current, which is the fill
    // program's uVis: without a restore, the frame that allocates them reads
    // the depth texture as its visibility map, every face counts as hidden and
    // the depth prepass comes out empty - a shadow that measures as no shadow
    // at any density, on the first AO frame and on every canvas resize.
    const oc = gpu.indexOf('function ensureOcc(w, h) {');
    if (oc < 0) throw new Error('ensureOcc is gone');
    const ocBody = gpu.slice(oc, gpu.indexOf('\nfunction ', oc + 10));
    if (!/getParameter\(gl\.TEXTURE_BINDING_2D\)/.test(ocBody)
        || !/bindTexture\(gl\.TEXTURE_2D, hadBound\)/.test(ocBody)) {
        throw new Error('ensureOcc does not put back the texture binding it borrows');
    }
});

// A HOVER MARK IS NOT PART OF THE PICTURE. The selection is something the user
// asked to have marked and belongs in a saved image; where the pointer happens
// to be does not - and an export renders from a different context entirely, so
// there is nobody to move the pointer off first.
t('the selection band is a proportion of what it marks, not a fixed width', () => {
    // A flat 7 px is a band at one zoom and a stripe with a ribbon inside it at
    // every other: zoomed out on 1TIM the drawn radius is 2 px and the band was
    // 18 px - four and a half times the thing it marks - and on a structure big
    // enough to pin the radius at its floor it was 18 px at every zoom.
    const widthAt = (radius) => {
        const v = haloViewer([1, 2], 8);
        v.displayWidth = 100; v.displayHeight = 80;
        v._ensurePickProjection = () => {};
        for (let i = 0; i < v.screenRadius.length; i++) v.screenRadius[i] = radius;
        const ops = [];
        const c = { ops, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { ops.push(this.lineWidth); },
            lineJoin: '', lineCap: '', lineWidth: 0, strokeStyle: '', fillStyle: '' };
        v._paintSelectionHalo(c, 1, new Set([1, 2]));
        return ops[0];
    };
    const zoomedOut = widthAt(2);
    const normal = widthAt(5.42);      // 1TIM at the default view
    const zoomedIn = widthAt(34.6);    // 1UBQ at zoom 4
    if (!(zoomedOut < normal && normal < zoomedIn)) {
        throw new Error('the band does not follow the zoom: '
            + [zoomedOut, normal, zoomedIn].join(' / '));
    }
    // ...AND IT IS MEASURED OFF THE DRAWN WIDTH, NOT THE CLICK TARGET.
    // screenRadius is a residue-sized picking radius - the same for a CA and
    // for the atom hanging off it - so a band taken from it at face value is
    // heavier than the thing it marks. At the default view that is 12.5 px
    // around a ribbon whose radius reads as 5.42, where it used to be 24.9.
    if (Math.abs(normal - 12.5) > 1) {
        throw new Error('the default view band is ' + normal + ', expected ~12.5');
    }
    // never much more than the geometry itself, once the floor stops binding.
    // At radius 2 the 2.5 px floor is what sets the width - a hairline still
    // has to be markable - and it is 7 px there, against 18 before any of this.
    for (const [band, r] of [[normal, 5.42], [zoomedIn, 34.6]]) {
        if (band / (2 * r) > 1.2) {
            throw new Error('the band is ' + (band / (2 * r)).toFixed(1)
                + ' times the geometry at radius ' + r);
        }
    }
    if (zoomedOut > 8) throw new Error('the floor is too heavy: ' + zoomedOut);
    // the ceiling keeps a zoomed-in band an annotation rather than a slab
    if (zoomedIn > 2 * (34.6 * 0.5 + 14) + 0.01) {
        throw new Error('the reach is uncapped: ' + zoomedIn);
    }
});

t('hover is marked in the selection\'s own style, and left out of exports', () => {
    // ONE BAND FOR BOTH. Hovering must not introduce a second visual language,
    // and where the two overlap it must not stain: the colour is translucent,
    // so a union is drawn rather than one band over the other.
    const v = haloViewer([2, 3], 8);
    v.highlightedAtoms = new Set([3, 4]);
    v.hoverInfo = { text: 'A GLY 39' };
    v.displayWidth = 100; v.displayHeight = 80;
    v._ensurePickProjection = () => {};
    const stub = (c) => {
        c.measureText = () => ({ width: 40 });
        c.setTransform = () => {}; c.scale = () => {}; c.rect = () => {};
        c.fillText = (t) => { c.ops.push(['text', t]); };
        return c;
    };

    const on = stub(haloCtx());
    v._paintOverlays(on, 1);
    if (on.ops.some((o) => o[0] === 'arc')) {
        throw new Error('hover drew a mark of its own - it must use the selection band');
    }
    if (on.ops.filter((o) => o[0] === 'stroke').length !== 1) {
        throw new Error('the band was stroked more than once - overlapping'
            + ' translucent strokes darken where selection and hover meet');
    }
    // 2,3 selected and 3,4 hovered: the band must span 2..4
    const joined = haloEdges(on, v).flat();
    for (const i of [2, 3, 4]) {
        if (!joined.includes(i)) throw new Error('position ' + i + ' is not in the band');
    }
    // ...and the readout is one line, no plate behind it
    const text = on.ops.filter((o) => o[0] === 'text');
    if (text.length !== 1 || text[0][1] !== 'A GLY 39') {
        throw new Error('the readout is not one line reading "A GLY 39": '
            + JSON.stringify(text));
    }
    if (on.ops.some((o) => o[0] === 'fill')) {
        throw new Error('the readout drew a background box');
    }

    const off = stub(haloCtx());
    v._exportPxScale = 2;
    v._paintOverlays(off, 2);
    if (off.ops.some((o) => o[0] === 'text')) {
        throw new Error('the hover readout reached an export');
    }
    const exported = haloEdges(off, v).flat();
    if (exported.includes(4)) {
        throw new Error('a hovered position was marked in an export');
    }
});

t('a drag previews live without re-rendering the molecule', () => {
    // Committing on every mousemove would be a full re-render per pointer
    // event - fine on a peptide, hopeless on a ribosome. The molecule does not
    // change during a sequence drag, so the frame is snapshotted once and each
    // update is a blit plus one halo pass.
    const v = haloViewer([1]);
    let renders = 0;
    v.render = () => { renders++; };
    const ctx = haloCtx();
    ctx.setTransform = () => {}; ctx.clearRect = () => {};
    const blits = [];
    ctx.drawImage = () => { blits.push(1); };
    v.ctx = ctx;
    v.canvas = { width: 100, height: 80, getContext: () => ctx };
    ctx.canvas = v.canvas;      // the snapshot refuses any other target - an export
    v.displayWidth = 100; v.displayHeight = 80;
    // a snapshot canvas, as document.createElement would give
    const snapCtx = { setTransform() {}, clearRect() {}, drawImage() {} };
    global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => snapCtx }) };

    // the snapshot is taken BY A RENDER, at the one moment the canvas holds the
    // molecule and no overlays - so stand in for that frame here
    v._snapshotCleanFrame(ctx);
    if (!v._previewLive) throw new Error('the frame was not snapshotted');
    v.updateSelectionPreview(new Set([4, 5]));
    if (renders !== 0) throw new Error('a preview update re-rendered the molecule');
    if (!blits.length) throw new Error('the snapshot was not blitted back');
    // and it must draw the PREVIEW, not the committed selection
    const drew = ctx.ops.filter((o) => o[0] === 'stroke' || o[0] === 'fill');
    if (drew.length !== 1) throw new Error('preview drew ' + drew.length + ' runs, expected 1');
    const moves = ctx.ops.filter((o) => o[0] === 'move' || o[0] === 'line');
    if (!moves.some((o) => o[1] === 40) || !moves.some((o) => o[1] === 50)) {
        throw new Error('the band is not on residues 4 and 5 - it drew the '
            + 'committed selection instead of the preview');
    }
});

t('a real frame supersedes the snapshot, and ending the preview restores', () => {
    const v = haloViewer([1]);
    v._previewLive = true;
    v._invalidateSelectionPreview();
    if (v._previewLive) {
        throw new Error('a real render left a stale snapshot behind - a rotation '
            + 'or frame step during a preview would keep painting the old frame');
    }
    v._previewLive = true;
    v._selectionPreview = new Set([9]);
    v.endSelectionPreview();
    if (v._selectionPreview) throw new Error('the preview outlived the drag');
    // with no preview the halo falls back to the committed selection
    const ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    const marks = ctx.ops.filter((o) => o[0] === 'move');
    if (!marks.length || Math.abs(marks[0][1] - 10) > 0.05) {
        throw new Error('after the drag the halo is not on the committed selection');
    }
});


t('a side chain is drawn heavier than a ligand in tube mode', () => {
    // Side chains ride the LIGAND path so the ligand machinery can build them,
    // and TYPE_BASELINES gives 'L' a deliberately thin 0.4 - a ligand is a
    // guest and should not out-weigh the chain it sits in. A side chain is part
    // of its residue, and at 0.4 it came out as a hairline hanging off a
    // full-width backbone: drawn all along, just far too faint to read.
    const v = new Cls();
    v.typeWidthMultipliers = { L: 0.4, P: 1.0, C: 0.5 };
    v.sidechainMap = new Map([[7, { owner: 3 }], [8, { owner: 3 }]]);
    const ligand = v._calculateSegmentWidthMultiplier(null, { type: 'L', idx1: 1, idx2: 2 });
    const sidechain = v._calculateSegmentWidthMultiplier(null, { type: 'L', idx1: 7, idx2: 8 });
    const backbone = v._calculateSegmentWidthMultiplier(null, { type: 'P', idx1: 1, idx2: 2 });
    if (!(sidechain > ligand)) {
        throw new Error('a side chain is drawn no heavier than a ligand ('
            + sidechain + ' vs ' + ligand + ')');
    }
    if (!(sidechain < backbone)) {
        throw new Error('a side chain is as heavy as the backbone it hangs off ('
            + sidechain + ' vs ' + backbone + ') - the backbone should stay the '
            + 'main line');
    }
    // a real ligand must be untouched by this
    if (ligand !== 0.4) throw new Error('the ligand width moved: ' + ligand);
    // stated absolutely, on the same scale as TYPE_BASELINES, so retuning the
    // LIGAND width cannot drag side chains along with it
    v.typeWidthMultipliers = { L: 0.9, P: 1.0, C: 0.5 };
    if (v._calculateSegmentWidthMultiplier(null, { type: 'L', idx1: 7, idx2: 8 }) !== sidechain) {
        throw new Error('the side-chain width followed the ligand width');
    }
    v.typeWidthMultipliers = { L: 0.4, P: 1.0, C: 0.5 };
    // and with no side chains materialised, nothing changes at all
    v.sidechainMap = null;
    if (v._calculateSegmentWidthMultiplier(null, { type: 'L', idx1: 7, idx2: 8 }) !== 0.4) {
        throw new Error('ligand width changed when no side chains are shown');
    }
});


t('the side-chain row is offered only when there is something to show', () => {
    // Glycine has no side chain, nor does a nucleotide, nor any residue in a
    // backbone-only model. A control that cannot do anything is worse than no
    // control.
    const v = new Cls();
    v.sidechains = { pos: new Int32Array([4, 4, 5, 5]) };   // only 4 and 5 have any
    if (!v.hasSidechainsFor([5, 6])) throw new Error('a residue with atoms was not offered');
    if (v.hasSidechainsFor([6, 7])) throw new Error('offered for residues with no atoms');
    if (v.hasSidechainsFor([])) throw new Error('offered for an empty selection');
    // a structure with no side-chain data at all
    v.sidechains = null;
    if (v.hasSidechainsFor([4])) throw new Error('offered with no table at all');
    v.sidechains = { pos: new Int32Array([]) };
    if (v.hasSidechainsFor([4])) throw new Error('offered with an empty table');
    // the owner set is cached against the TABLE, so a new table is picked up
    v.sidechains = { pos: new Int32Array([9]) };
    if (!v.hasSidechainsFor([9])) throw new Error('a replaced table was not picked up');
    const first = v.sidechainOwners();
    if (v.sidechainOwners() !== first) throw new Error('the owner set is rebuilt every call');
});


t('the panel hides the side-chain row when the selection has none', () => {
    // through the real updateSelectionToolsState, not just the predicate
    const none = panelRun([4, 5], new Set());
    if (none.sidechainRow.hidden !== true) {
        throw new Error('the side-chain row is shown for a selection with no '
            + 'side chains - every control in it is a no-op there');
    }
    const some = panelRun([4, 5], new Set([5]));
    if (some.sidechainRow.hidden !== false) {
        throw new Error('the side-chain row is hidden although residue 5 has one');
    }
    // and with nothing selected the whole panel goes, row included
    if (panelRun(null).sidechainRow.hidden !== true) {
        throw new Error('the row survived an empty selection');
    }
});


t('side chains cast no shadow on the backbone, but still receive one', () => {
    // A side chain is a thin stick at a fifth of the backbone's weight sitting
    // right against it, so every one would print a hard little shadow on the
    // chain it grows out of - and that reads as the backbone being dented, not
    // as the side chain being in front.
    const v = new Cls();
    v.sidechainMap = new Map([[7, { owner: 3 }], [8, { owner: 3 }]]);
    const bb = { type: 'P', idx1: 3, idx2: 4 };
    const sc = { type: 'L', idx1: 7, idx2: 8 };
    const caCb = { type: 'L', idx1: 3, idx2: 7 };   // the bond to the backbone
    const lig = { type: 'L', idx1: 20, idx2: 21 };  // a real ligand
    if (!v._shadowPairExcluded(bb, sc)) {
        throw new Error('a side chain casts on the backbone');
    }
    if (!v._shadowPairExcluded(bb, caCb)) {
        throw new Error('the CA-CB bond casts on the backbone - one end of it is'
            + ' a backbone position, so testing only idx1 would miss it');
    }
    // the other direction is kept: that is the one that carries depth
    if (v._shadowPairExcluded(sc, bb)) {
        throw new Error('the backbone no longer shades side chains');
    }
    // a real ligand is untouched by this
    if (v._shadowPairExcluded(bb, lig)) {
        throw new Error('a ligand stopped casting on the backbone');
    }
    // and with no side chains shown, nothing changes
    v.sidechainMap = null;
    if (v._shadowPairExcluded(bb, sc)) {
        throw new Error('excluded with no side chains materialised');
    }
});

t('contacts still exchange no shadow with the structure', () => {
    // the rule this was factored out of - one copy now, so the two cannot drift
    const v = new Cls();
    v.sidechainMap = null;
    const bb = { type: 'P', idx1: 1, idx2: 2 };
    const contact = { type: 'C', idx1: 5, idx2: 9 };
    if (!v._shadowPairExcluded(bb, contact)) throw new Error('a contact casts on the structure');
    if (!v._shadowPairExcluded(contact, bb)) throw new Error('the structure casts on a contact');
    for (const t2 of ['D', 'R']) {
        if (!v._shadowPairExcluded({ type: t2, idx1: 1, idx2: 2 }, contact)) {
            throw new Error('a contact casts on ' + t2);
        }
    }
});


// ---- CONTACTS ---------------------------------------------------------------
// Stored on the object as `contacts`, which already existed and is already
// saved and restored; the renderer turns each entry into a segment of type 'C'.
// The GUI writes the CHAIN + RESIDUE form, not position indices: indices belong
// to the current frame's arrays and a copied sub-structure renumbers them,
// while a chain and residue number name the same pair whatever happens.
const contactBody = (() => {
    const a = appSrc.indexOf('    const contactKeyOf = ');
    const b = appSrc.indexOf('    // SIDE CHAINS, per residue.');
    if (a < 0 || b < 0) throw new Error('contact helpers not found in web/app.js');
    return appSrc.slice(a, b);
})();
function contactApi(objectsData) {
    const renderer = {
        currentObjectName: 'obj', objectsData,
        chains: ['A', 'A', 'A', 'B', 'B'],
        residueNumbers: [10, 11, 12, 20, 21],
        _invalidateSegmentCache() { this._inv = true; },
        _loadFrameData() { this._loaded = (this._loaded || 0) + 1; },
        currentFrame: 0,
        render() { this._rendered = (this._rendered || 0) + 1; },
    };
    // eslint-disable-next-line no-new-func
    const f = new Function('viewerApi', 'window',
        contactBody + '; return { addSelectionContact, removeSelectionContact,'
        + ' setSelectionContactColor, setSelectionContactWidth, findContact };'
    )({ renderer }, {});
    return { ...f, renderer };
}

t('a contact is added between the two selected residues, once', () => {
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    api.addSelectionContact([0, 3]);
    if (!objectsData.obj.contacts || objectsData.obj.contacts.length !== 1) {
        throw new Error('no contact was added');
    }
    // chain + residue, not indices
    const c = objectsData.obj.contacts[0];
    if (c[0] !== 'A' || c[1] !== 10 || c[2] !== 'B' || c[3] !== 20) {
        throw new Error('stored as ' + JSON.stringify(c) + ' - expected the'
            + ' chain and residue of each end');
    }
    // adding the same pair again must not duplicate it, in either order
    api.addSelectionContact([0, 3]);
    api.addSelectionContact([3, 0]);
    if (objectsData.obj.contacts.length !== 1) {
        throw new Error('the same contact was added ' + objectsData.obj.contacts.length
            + ' times - a contact has no direction, so the reversed pair is the'
            + ' same contact');
    }
    // and the segment cache must go, since contacts become segments
    if (!api.renderer._inv) throw new Error('the segment cache was not invalidated');
});

t('a contact is found and removed whichever way round it is selected', () => {
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    api.addSelectionContact([0, 3]);
    if (!api.findContact([3, 0])) throw new Error('not found with the pair reversed');
    if (api.findContact([0, 4])) throw new Error('found for a pair that has none');
    api.removeSelectionContact([3, 0]);
    if (objectsData.obj.contacts) throw new Error('the contact survived removal');
});

t('a contact colour is stored as rgb, and clearing it leaves the contact', () => {
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    api.addSelectionContact([0, 3]);
    api.setSelectionContactColor([0, 3], '#ff8800');
    let c = objectsData.obj.contacts[0];
    if (typeof c[4] !== 'number') throw new Error('the weight slot was lost');
    if (!c[5] || c[5].r !== 255 || c[5].g !== 136 || c[5].b !== 0) {
        throw new Error('colour stored as ' + JSON.stringify(c[5]) + ' - the'
            + ' segment builder reads an {r,g,b} object');
    }
    api.setSelectionContactColor([0, 3], null);
    c = objectsData.obj.contacts[0];
    if (c.length !== 5) throw new Error('clearing the colour left ' + c.length
        + ' fields - it should drop back to the default yellow, not remove the'
        + ' contact');
    if (!objectsData.obj.contacts.length) throw new Error('the contact was removed');
});

t('the contact row is offered for exactly two residues', () => {
    if (panelRun([4, 5]).contactRow.hidden !== false) {
        throw new Error('hidden for a pair, which is the only case it works for');
    }
    for (const sel of [[4], [4, 5, 6], null]) {
        if (panelRun(sel).contactRow.hidden !== true) {
            throw new Error('offered for ' + JSON.stringify(sel)
                + ' - a contact is a line between a PAIR');
        }
    }
});


t('what the GUI writes, the renderer resolves', () => {
    // The two halves were tested apart: that addSelectionContact stores chain +
    // residue, and separately that the renderer turns contacts into segments.
    // Nothing checked that the FORMAT one writes is the one the other reads,
    // which is the only way a contact can be stored correctly and still not
    // appear.
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    api.addSelectionContact([0, 3]);
    const stored = objectsData.obj.contacts[0];

    const v = new Cls();
    v.chains = ['A', 'A', 'A', 'B', 'B'];
    v.residueNumbers = [10, 11, 12, 20, 21];
    const got = v._resolveContactToIndices(stored, 5);
    if (!got) throw new Error('the renderer could not resolve ' + JSON.stringify(stored));
    if (got.idx1 !== 0 || got.idx2 !== 3) {
        throw new Error('resolved to ' + got.idx1 + ',' + got.idx2
            + ' - expected the two residues it was made from');
    }
    if (typeof got.weight !== 'number') throw new Error('no weight resolved');
    // ...and with a colour on it
    api.setSelectionContactColor([0, 3], '#ff8800');
    const got2 = v._resolveContactToIndices(objectsData.obj.contacts[0], 5);
    if (!got2 || got2.idx1 !== 0 || got2.idx2 !== 3) {
        throw new Error('a coloured contact stopped resolving');
    }
    if (!got2.color || got2.color.r !== 255) {
        throw new Error('the colour did not survive: ' + JSON.stringify(got2.color));
    }
});


t('committing a contact RELOADS the frame, not just repaints', () => {
    // The segment list - contact block included - is built inside setCoords,
    // not inside render. Invalidating the cache and repainting therefore
    // changes nothing at all: the contact is stored correctly, resolves
    // correctly, and never appears. That is exactly what happened.
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    api.addSelectionContact([0, 3]);
    if (!api.renderer._loaded) {
        throw new Error('adding a contact did not reload the frame - segments'
            + ' are built in setCoords, so a repaint alone leaves it invisible');
    }
    const after = api.renderer._loaded;
    api.removeSelectionContact([0, 3]);
    if (api.renderer._loaded <= after) {
        throw new Error('removing a contact did not reload the frame');
    }
});

t('the contact toggle reflects whether a contact exists', () => {
    // It replaced an Add button and a Remove button that were shown and hidden
    // in turn. One control now, and its STATE is the answer - which is also
    // what makes "is there a contact between these two" readable at a glance.
    const without = panelRun([4, 5], new Set(), false);
    if (without.contactShowToggle.checked) {
        throw new Error('the toggle is on for a pair with no contact');
    }
    if (without.contactColorButton.parentElement.hidden !== true) {
        throw new Error('a colour is offered with no contact to colour');
    }
    const withOne = panelRun([4, 5], new Set(), true);
    if (!withOne.contactShowToggle.checked) {
        throw new Error('the toggle is off for a pair that has a contact');
    }
    if (withOne.contactColorButton.parentElement.hidden !== false) {
        throw new Error('no colour control for an existing contact');
    }
});



t('clicking a contact selects the two residues it joins', () => {
    // pickResidueAt already tests contact segments - it has to, or the line
    // would not be clickable - but it attributes the hit to the nearer END, so
    // clicking a contact selected one of its two residues and the fact that it
    // was a contact was thrown away.
    const v = new Cls();
    v.positionTypes = ['P', 'P', 'P', 'P', 'P'];
    v.segmentIndices = [];
    v.sidechainMap = null;
    v.currentObjectName = 'obj';
    v.objectsData = { obj: {} };

    // a contact between 1 and 4 was what the click landed on
    v._pickedContact = [1, 4];
    for (const end of [1, 4]) {
        const pick = v.pickGroupAt(end);
        if (pick.length !== 2 || !pick.includes(1) || !pick.includes(4)) {
            throw new Error('clicking the contact at end ' + end + ' picked '
                + JSON.stringify(pick) + ' - it should name the pair it joins');
        }
    }
    // a residue that is NOT an end of it is unaffected
    if (JSON.stringify(v.pickGroupAt(2)) !== '[2]') {
        throw new Error('an unrelated residue was widened to the contact');
    }
    // and with no contact hit, an endpoint is just a residue: a click ON a
    // residue that happens to end a contact is a click on the residue
    v._pickedContact = null;
    if (JSON.stringify(v.pickGroupAt(1)) !== '[1]') {
        throw new Error('a residue pick was widened although no contact was hit');
    }
});


t('a contact pick does not outlive the click that made it', () => {
    // _pickedContact is set by pickResidueAt and read by pickGroupAt. Left
    // standing after a click that hit something else, the NEXT residue pick
    // would be widened to a contact the user is no longer pointing at.
    const v = new Cls();
    v.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    v.screenX = new Float64Array([0, 100, 200, 300]);
    v.screenY = new Float64Array([0, 0, 0, 100]);
    v.screenRadius = new Float64Array([6, 6, 6, 6]);
    v.screenValid = new Uint8Array([3, 3, 3, 3]);
    v.screenFrameId = 3;
    v.rotatedCoords = [{ z: 0 }, { z: 0 }, { z: 0 }, { z: 0 }];
    v.positionTypes = ['P', 'P', 'P', 'P'];
    v.sidechainMap = null;
    v._naPick = null;
    v.segmentIndices = [
        // a contact spanning 0..2 along y = 0
        { type: 'C', idx1: 0, idx2: 2, contactIdx1: 0, contactIdx2: 2 },
        // an ordinary residue off on its own
        { type: 'P', idx1: 3, idx2: 3 },
    ];
    // click the middle of the contact: both ends
    let pick = v.pickGroupAt(v.pickResidueAt(100, 0));
    if (pick.length !== 2 || !pick.includes(0) || !pick.includes(2)) {
        throw new Error('clicking the contact line picked ' + JSON.stringify(pick));
    }
    // now click the lone residue: just that one
    pick = v.pickGroupAt(v.pickResidueAt(300, 100));
    if (JSON.stringify(pick) !== '[3]') {
        throw new Error('after clicking elsewhere the pick was still widened to'
            + ' the contact: ' + JSON.stringify(pick));
    }
    // THE CASE THAT ACTUALLY BITES. A stale value only matters when the next
    // pick lands on an END of the old contact, and clicking near an end
    // normally hits the contact line too - so the contact is taken out of the
    // frame first (its far end no longer projected, as when it scrolls off or
    // is removed) and residue 0 clicked on its own. Cleared, that is one
    // residue; left standing, it widens to a contact that is no longer there.
    pick = v.pickGroupAt(v.pickResidueAt(100, 0));
    if (pick.length !== 2) throw new Error('the contact stopped being pickable');
    v.screenValid[2] = 0;
    pick = v.pickGroupAt(v.pickResidueAt(0, 0));
    if (JSON.stringify(pick) !== '[0]') {
        throw new Error('picked ' + JSON.stringify(pick) + ' for a lone residue'
            + ' - _pickedContact outlived the click that made it, so an endpoint'
            + ' is still being widened to a contact that is no longer drawn');
    }
});


t('each contact carries its own width, and the panel follows it', () => {
    // The Line Width control sets how heavy the BACKBONE is drawn; a contact is
    // an annotation over the structure, not part of it, so it keeps its own -
    // and its own is PER CONTACT, held in the entry's existing weight slot,
    // which the renderer already scales the stroke by.
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    api.addSelectionContact([0, 3]);
    if (objectsData.obj.contacts[0][4] !== 1.0) {
        throw new Error('a new contact does not start at weight 1');
    }
    api.setSelectionContactWidth([0, 3], 2.4);
    if (objectsData.obj.contacts[0][4] !== 2.4) {
        throw new Error('the width did not reach the weight slot');
    }
    // ...and must not disturb the colour, which lives in the slot after it
    api.setSelectionContactColor([0, 3], '#00ff00');
    api.setSelectionContactWidth([0, 3], 0.5);
    const c = objectsData.obj.contacts[0];
    if (c[4] !== 0.5) throw new Error('the width was lost');
    if (!c[5] || c[5].g !== 255) throw new Error('changing the width dropped the colour');
    // the slider is offered only with a contact to size, and loads its value
    const withOne = panelRun([4, 5], new Set(), true);
    if (withOne.contactWidthSlider.hidden !== false) throw new Error('no width control for a contact');
    if (withOne.contactWidthSlider.value !== 1.5) {
        throw new Error('the slider shows ' + withOne.contactWidthSlider.value
            + ' rather than the contact\'s stored width - it would snap the'
            + ' contact to whatever the slider happened to be left at');
    }
    const without = panelRun([4, 5], new Set(), false);
    if (without.contactWidthSlider.hidden !== true) {
        throw new Error('a width control is offered with no contact to size');
    }
});


t('the contact row reads colour, add or remove, then width', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const at = (id) => {
        const i = html.indexOf('id="' + id + '"');
        if (i < 0) throw new Error('missing control: ' + id);
        return i;
    };
    const order = ['contactColorButton', 'contactShowToggle',
        'contactWidthSlider'].map(at);
    for (let i = 1; i < order.length; i++) {
        if (!(order[i] > order[i - 1])) {
            throw new Error('the contact row is out of order - colour, then the'
                + ' toggle, then the width');
        }
    }
    // FULL WIDTH IS THE MAXIMUM: the slider takes a contact DOWN from the width
    // it is drawn at rather than letting it grow past it, so an annotation
    // cannot outweigh the structure it annotates.
    const tag = html.slice(at('contactWidthSlider') - 200,
        html.indexOf('>', at('contactWidthSlider')));
    const max = /max="([0-9.]+)"/.exec(tag);
    const min = /min="([0-9.]+)"/.exec(tag);
    if (!max || +max[1] !== 1) {
        throw new Error('the width slider maxes at ' + (max && max[1])
            + ' - full width is the maximum, and 1 is full width');
    }
    if (!min || !(+min[1] > 0) || !(+min[1] < 1)) {
        throw new Error('the width slider has no usable range below full width');
    }
});


t('a contact loaded from a contacts file is the same contact to the GUI', () => {
    // parseContactsFile writes the SAME entries the panel does - it has two
    // forms, "A 10 B 50 0.5" and the bare-index "10 50 0.5". The panel only
    // understood the first, so a file written in indices was invisible to it:
    // clicking the pair offered Add and made a duplicate, and Remove, colour
    // and width all failed to find it.
    const objectsData = { obj: {} };
    const api = contactApi(objectsData);
    // as the file loader produces it: positions 0 and 3, weight 0.5
    objectsData.obj.contacts = [[0, 3, 0.5]];
    if (!api.findContact([0, 3])) {
        throw new Error('a file-loaded contact in INDEX form is invisible to the'
            + ' panel - Add would duplicate it and Remove would miss it');
    }
    if (!api.findContact([3, 0])) throw new Error('not found with the pair reversed');
    if (api.findContact([0, 4])) throw new Error('matched a pair it does not join');
    // and Add must not duplicate one that came from a file
    api.addSelectionContact([0, 3]);
    if (objectsData.obj.contacts.length !== 1) {
        throw new Error('Add duplicated a contact that came from a file');
    }
    // removing and colouring reach it too
    api.setSelectionContactColor([0, 3], '#00ff00');
    const c = objectsData.obj.contacts[0];
    if (!c || !c[3] || c[3].g !== 255) {
        throw new Error('colour did not reach a file-loaded contact: '
            + JSON.stringify(c));
    }
    api.removeSelectionContact([0, 3]);
    if (objectsData.obj.contacts) throw new Error('a file-loaded contact could not be removed');
});


t('everything the selection panel sets is written to a saved session', () => {
    // Each of these is stored somewhere different, and the save path names its
    // fields ONE BY ONE - anything not listed is dropped in silence, which has
    // already happened three times in this codebase.
    const app = appSrc;
    const saved = app.slice(app.indexOf('const objToSave = {'),
        app.indexOf('const stateData', app.indexOf('const objToSave = {')));
    for (const [what, field] of [
        ['contacts (with their colour and width inside)', 'contacts'],
        ['which residues show a side chain', 'sidechains'],
        ['per-residue side-chain colour', 'sidechain_color'],
        ['per-residue colour', 'color'],
        ['secondary-structure overrides', 'sse'],
    ]) {
        if (!new RegExp('objToSave\\.' + field + '\\s*=').test(saved)) {
            throw new Error(what + ' is not written to a saved session'
                + ' (objToSave.' + field + ')');
        }
    }
    // ...and read back. The restore path is equally field-by-field.
    for (const field of ['contacts', 'sidechains', 'sidechain_color']) {
        if (!new RegExp('objData\\.' + field).test(app)) {
            throw new Error('objData.' + field + ' is never read back on load');
        }
    }
    // the per-frame side-chain table rides on the frame, not the object
    if (!/frameData\.sidechains/.test(app) || !/reviveSidechainTable/.test(app)) {
        throw new Error('the side-chain atom table is not carried through a save');
    }
});


t('a contact is the same width in both styles, and neither follows Line Width', () => {
    // The two styles draw contacts through different code, so the width has to
    // be the same NUMBER in both or a contact changes weight when you switch -
    // which is the one thing this is for. The value is what tube used to draw
    // at its widest: the Line Width slider tops out at 4.7 and TYPE_BASELINES
    // gives a contact half of it.
    const cartoonSrc = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    const line = cartoonSrc.split('\n').find((l) => l.trim().startsWith('const CONTACT_WIDTH ='));
    if (!line) throw new Error('CONTACT_WIDTH not found in viewer-cartoon.js');
    const cartoonW = parseFloat(line.split('=')[1]);
    if (Math.abs(cartoonW - CONTACT_WIDTH_A) > 1e-9) {
        throw new Error('the cartoon draws contacts at ' + cartoonW + ' and tube at '
            + CONTACT_WIDTH_A + ' - a contact would change width when the style'
            + ' is switched');
    }
    // and it is HALF what tube used to draw at its widest: the Line Width
    // slider's maximum, times the 0.5 contact baseline, halved again
    const html = fs.readFileSync('index.html', 'utf8');
    const sl = html.slice(html.indexOf('id="lineWidthSlider"') - 120,
        html.indexOf('>', html.indexOf('id="lineWidthSlider"')));
    const lwMax = parseFloat(/max="([0-9.]+)"/.exec(sl)[1]);
    const want = lwMax * 0.5 / 2;
    if (Math.abs(CONTACT_WIDTH_A - want) > 1e-9) {
        throw new Error('a full-weight contact is ' + CONTACT_WIDTH_A + ', not '
            + want + ' (Line Width max ' + lwMax + ' x the 0.5 contact baseline,'
            + ' halved)');
    }
    // TUBE must not follow the control either: the multiplier divides it back
    // out, so the drawn width is constant
    const v = new Cls();
    v.typeWidthMultipliers = { C: 0.5, P: 1.0 };
    const drawn = (lw, weight) => {
        v.lineWidth = lw;
        return lw * v._calculateSegmentWidthMultiplier(null,
            { type: 'C', idx1: 0, idx2: 1, contactWeight: weight });
    };
    if (Math.abs(drawn(2.0, 1) - drawn(4.7, 1)) > 1e-9) {
        throw new Error('tube draws a contact at ' + drawn(2.0, 1) + ' and '
            + drawn(4.7, 1) + ' at the two ends of the Line Width control');
    }
    if (Math.abs(drawn(3.0, 1) - CONTACT_WIDTH_A) > 1e-9) {
        throw new Error('tube draws a full-weight contact at ' + drawn(3.0, 1)
            + ', not ' + CONTACT_WIDTH_A);
    }
    // its own weight still scales it, in both
    if (Math.abs(drawn(3.0, 0.5) - CONTACT_WIDTH_A / 2) > 1e-9) {
        throw new Error('the per-contact weight no longer scales the tube width');
    }
});


// ---- SAVED STATE ------------------------------------------------------------
// Two writers, one format. Both sides wrote `"version": "2.0"` while disagreeing
// about what was in it, so a file saved by one opened in the other with its
// settings quietly reset.
const stateKeys = (src, open2, close2) => {
    const a = src.indexOf(open2);
    if (a < 0) throw new Error('state envelope not found: ' + open2);
    let d = 0; let k = src.indexOf('{', a);
    const start = k;
    for (; k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) break; }
    }
    const body = src.slice(start, k);
    return new Set([...body.matchAll(/(?:^|\n)\s*"?([a-z_]+)"?\s*:/g)].map((m) => m[1]));
};

t('the web and Python state files have the same envelope', () => {
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    const w = stateKeys(appSrc, 'const stateData = {');
    const p = stateKeys(py, 'state_data = {');
    for (const k of p) {
        if (!w.has(k)) throw new Error('Python writes "' + k + '" and the web does not');
    }
    // selections_by_object is web-only by design: Python has no selection model
    for (const k of w) {
        if (k === 'selections_by_object') continue;
        if (!p.has(k)) throw new Error('the web writes "' + k + '" and Python does not');
    }
    // both must name the object the same way Python reads it
    if (!w.has('current_object') || !p.has('current_object')) {
        throw new Error('current_object is what Python reads to pick the object');
    }
    if (!w.has('viewer_state') || !p.has('viewer_state')) {
        throw new Error('viewer_state is what the web reads to restore its settings');
    }
});

t('the saved config agrees with the live state rather than the starting one', () => {
    // window.viewerConfig holds the values the viewer STARTED with. Saving it
    // as-is put a stale copy of every render setting beside the live one - a
    // session showing a cartoon recorded `config.rendering.style: "tube"` next
    // to `viewer_state.style: "cartoon"`, which reads as a bug in the file.
    // It cannot just be dropped: py2Dmol/viewer.py does
    // `self.config = state_data["config"]` when it loads a state.
    const i = appSrc.indexOf('savedConfig.rendering = {');
    if (i < 0) throw new Error('the saved config is not brought up to date before writing');
    const body = appSrc.slice(i, appSrc.indexOf('};', i));
    for (const k of ['style', 'preset', 'thickness', 'outline', 'width', 'shade']) {
        if (!new RegExp('\\b' + k + ':\\s*viewerState\\.').test(body)) {
            throw new Error('config.rendering.' + k + ' is not taken from the live'
                + ' state, so it is written stale');
        }
    }
    if (/config: window\.viewerConfig\b/.test(appSrc)) {
        throw new Error('the starting config is still written verbatim');
    }
    // ...and Python prefers viewer_state where it says anything
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    if (!/state_data\.get\("viewer_state"\)/.test(py)) {
        throw new Error('Python ignores viewer_state, so a web-saved session'
            + ' loads on whatever config happened to carry');
    }
});


t('click-selection is off unless something turns it on', () => {
    // The Python path loads viewer-mol.js and the cartoon plugin and nothing
    // else - no sequence strip, no selection panel - so a click there changed a
    // selection with no way to see it, act on it, or clear it except by
    // clicking the background again. Selection is done in Python by scripting,
    // which does not go through the mouse.
    const src = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (!/this\.selectionEnabled = false;/.test(src)) {
        throw new Error('the renderer does not default click-selection to off');
    }
    // BOTH click entry points must be gated. Anchored on the code that
    // actually mutates the selection, not on the listener registration: there
    // is more than one mouseup listener, so indexOf found the wrong one and the
    // check passed with the real handler ungated.
    const gated = (mutation, back) => {
        const at = src.indexOf(mutation);
        if (at < 0) throw new Error('selection mutation not found: ' + mutation);
        if (!/selectionEnabled/.test(src.slice(Math.max(0, at - back), at))) {
            throw new Error('`' + mutation.trim() + '` runs on a click without'
                + ' checking selectionEnabled first');
        }
    };
    // the dblclick chain-select, and the mouseup pick and background-clear
    gated('for (let k = 0; k < this.chains.length; k++) {', 900);
    gated('// empty background: deselect, as in PyMOL', 900);
    // and the web app is what turns it on
    if (!/renderer\.selectionEnabled = true/.test(appSrc)) {
        throw new Error('web/app.js never enables click-selection, so the panel'
            + ' can only ever be reached from the sequence strip');
    }
    // the PYTHON page must not: it loads neither app.js nor the strip
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    if (/selectionEnabled\s*=\s*true/i.test(py)) {
        throw new Error('the Python path turns click-selection on, but has no'
            + ' selection UI to show the result');
    }
});

// DETECT CYCLIC is off in the web app and on in Python, and that difference is
// deliberate - so it is the kind of thing that gets "fixed" back to matching.
// Both halves are pinned, along with the wiring between the toggle and the
// renderer, which runs through a config key name shared across three files and
// nothing but the name.
t('detect cyclic is off by default in the web app, and on in Python', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const i = html.indexOf('id="detectCyclicCheckbox"');
    if (i < 0) throw new Error('no Detect Cyclic toggle in the Options panel');
    // the INPUT tag only, so a `checked` anywhere else on the page cannot
    // stand in for one here
    const tag = html.slice(html.lastIndexOf('<', i), html.indexOf('>', i));
    if (/\bchecked\b/.test(tag)) {
        throw new Error('the Detect Cyclic toggle ships checked; it is opt-in'
            + ' because the test is a distance one and a folded linear chain'
            + ' passes it');
    }
    // ...and the config behind it agrees, or the toggle shows one thing on
    // load while the renderer does another
    if (!/detect_cyclic:\s*false/.test(appSrc)) {
        throw new Error('web/app.js does not default detect_cyclic to false,'
            + ' so the unchecked toggle disagrees with what is drawn');
    }
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    if (!/"detect_cyclic":\s*True/.test(py)) {
        throw new Error('the Python default is no longer True - it is scripted'
            + ' by someone who knows what they loaded, and the asymmetry with'
            + ' the web app is the point');
    }

    // THE KEY NAME IS THE WHOLE WIRING. app.js writes it onto
    // window.viewerConfig.rendering, which the renderer normalises in place and
    // keeps as its own this.config; nothing else connects the two, so a rename
    // on either side leaves a toggle that changes a field no one reads.
    if (!/rendering\?\.detect_cyclic/.test(src)) {
        throw new Error('viewer-mol.js no longer reads'
            + ' config.rendering.detect_cyclic, so the toggle is orphaned');
    }

    // AND IT HAS TO RELOAD THE FRAME. The ring is closed in setCoords, not in
    // render, so a handler that only repaints changes nothing on screen - the
    // exact trap the side-chain and contact toggles both hit.
    const a = appSrc.indexOf("detectCyclicEl.addEventListener('change'");
    if (a < 0) throw new Error('the Detect Cyclic toggle is never wired up');
    const handler = appSrc.slice(a, appSrc.indexOf('\n    }', a));
    if (!/_loadFrameData/.test(handler)) {
        throw new Error('the Detect Cyclic handler repaints without reloading'
            + ' the frame, and segments - the closing bond among them - are'
            + ' built in setCoords, not in render');
    }
});


// COLOURING A SIDE CHAIN MUST INCLUDE ITS CA-CB BOND.
//
// The root bond is emitted as [owner, CB] - its idx1 is the BACKBONE alpha
// carbon - and both colour paths resolve a segment through `segInfo.origIndex`,
// which for that bond is the owner. So every bond of a side chain took the new
// colour except the first, which kept the backbone's: reported as "when I click
// on side chain, select color, it does not include ca-cb bond in the color".
// ...AND BOTH COLOUR PATHS MUST ACTUALLY ASK. The test above proves the helper
// is right; it cannot tell whether the code calls it. There are two paths -
// _calculateSegmentColors and the pLDDT one, which is used INSTEAD of it in
// plddt/deepmind/auto-for-AlphaFold modes - and fixing one and not the other is
// the obvious way for this bug to come back on half the colour modes. Checked
// against the source text, the way the frame builders are.
t('both segment colour paths resolve through _colorSegmentPosition', () => {
    for (const fn of ['_calculateSegmentColors', '_calculatePlddtColors']) {
        // the DEFINITION, not the first call site: `this.colors =
        // this._calculateSegmentColors()` appears earlier in the file, and
        // slicing from there reads somebody else's body.
        const m = src.match(new RegExp('\\n        ' + fn + '\\s*\\('));
        if (!m) throw new Error(fn + ' is gone - it was renamed, so nothing'
            + ' here checks it any more');
        const i = m.index;
        // the body, to the next method at the same indentation
        const end = src.indexOf('\n        }', i);
        const body = src.slice(i, end);
        if (!/_colorSegmentPosition\(/.test(body)) {
            throw new Error(fn + ' does not call _colorSegmentPosition - it is'
                + ' back on segInfo.origIndex, so the bond joining a side chain'
                + ' to its backbone takes the main chain colour again');
        }
        if (/const positionIndex = segInfo\.origIndex/.test(body)) {
            throw new Error(fn + ' still reads segInfo.origIndex directly');
        }
    }
});

t('a side chain colour reaches its CA-CB bond', () => {
    const d = scFixture();
    const v = scViewer([2]);
    const out = v._materialiseSidechains(d);
    v.coords = out.coords;
    v.objectsData.obj.sidechainColor = { 2: '#ff0000' };
    // getAtomColor consults these on its way to the colour hierarchy
    v.overlayState = { enabled: false };
    v.chains = out.chains || new Array(out.coords.length).fill('A');
    v.currentFrame = 0;
    v.colorMode = 'chain';

    // the bonds materialisation produced, as the segment builder sees them
    const bonds = out.bonds || [];
    if (!bonds.length) throw new Error('no side-chain bonds were produced');
    const root = bonds.find((b) => b[0] === 2 || b[1] === 2);
    if (!root) throw new Error('no bond joins the side chain to its CA');
    const inner = bonds.find((b) => b !== root);

    // segments are built with origIndex = idx1, which for the root bond is the
    // BACKBONE alpha carbon
    const seg = { idx1: root[0], idx2: root[1], origIndex: root[0], type: 'L' };
    const pos = v._colorSegmentPosition(seg);
    const col = v._sidechainColorOf(pos);
    if (!col || col.r !== 255 || col.g !== 0 || col.b !== 0) {
        throw new Error('the CA-CB bond resolves its colour from position ' + pos
            + ', which carries ' + (col ? `${col.r},${col.g},${col.b}` : 'no side-chain colour')
            + ' - a bond with one end on a side-chain atom is part of that side'
            + ' chain and has to be coloured with it');
    }
    // ...and the rule must not reach past the side chain: a backbone segment
    // still resolves through its own origIndex
    const bb = { idx1: 1, idx2: 2, origIndex: 1, type: 'P' };
    if (v._colorSegmentPosition(bb) !== 1) {
        throw new Error('a backbone segment no longer resolves through its own'
            + ' origIndex - the rule has reached past the side chain');
    }
    if (inner) {
        const segIn = { idx1: inner[0], idx2: inner[1], origIndex: inner[0], type: 'L' };
        if (!v._sidechainColorOf(v._colorSegmentPosition(segIn))) {
            throw new Error('an inner side-chain bond lost its colour');
        }
    }
});


// CAPTURE IS ONE CONTROL WITH ONE NAME.
//
// It used to relabel itself "Save Video" whenever Rotate or Draw was on and
// swap its icon, so the same button in the same place meant different things
// depending on state - next to a separate record button that meant a third
// thing (recording the frames playing through). Reported as confusing. What
// gets made is now chosen INSIDE the panel, where the options are visible.
//
// The name is "Capture", not "Save": the toolbar's other Save writes the
// session file, and two buttons reading Save a few centimetres apart is a coin
// toss over which one keeps your work.
t('the Capture button does not change identity with the animation state', () => {
    const btn = {
        title: '',
        _icon: { classes: new Set(['fa-camera']),
            classList: { add(c) { btn._icon.classes.add(c); },
                remove(c) { btn._icon.classes.delete(c); },
                toggle(c, on) { if (on) btn._icon.classes.add(c); else btn._icon.classes.delete(c); } } },
        _text: { nodeType: 3, textContent: 'Capture' },
        querySelector(sel) { return sel === 'i' ? btn._icon : btn._span; },
        setAttribute() {},
    };
    btn._span = { childNodes: [btn._text], appendChild() {},
        querySelector() { return null } };
    btn._span.childNodes.forEach = Array.prototype.forEach.bind(btn._span.childNodes);

    const v = new Cls();
    v.saveImageButton = btn;
    v._savePanel = null;
    const seen = new Set();
    for (const [rot, draw] of [[false, false], [true, false], [false, true], [true, true]]) {
        v.autoRotate = rot; v.drawMode = draw;
        v._syncSaveButtonMode();
        seen.add(btn._text.textContent);
        if (!btn._icon.classes.has('fa-camera') || btn._icon.classes.has('fa-video')) {
            throw new Error('the Capture button swapped its icon with rotate=' + rot
                + ' draw=' + draw + ' - one control, one face');
        }
    }
    if (seen.size !== 1 || !seen.has('Capture')) {
        throw new Error('the Capture button called itself ' + [...seen].join(' / ')
            + ' depending on state; it must always read Capture');
    }
});

// ...AND RECORDING STILL HAS A HOME. Deleting the record button without moving
// what it did would silently drop trajectory recording, which is a DIFFERENT
// video from the rotation and drawing ones the panel already offered: it plays
// the frames through. The panel builds a row for it whenever the object has
// frames to play, and that row calls toggleRecording.
t('the save panel can still record a trajectory', () => {
    // the DEFINITION, not the call site inside setUIControls - slicing from
    // the first match reads somebody else's body, which is how this test first
    // reported the feature missing while it was there
    const m = src.match(/\n        _toggleSaveImagePanel\s*\(/);
    if (!m) throw new Error('_toggleSaveImagePanel is gone');
    const body = src.slice(m.index, src.indexOf('\n        }\n', m.index));
    if (!/data-traj/.test(body)) {
        throw new Error('the save panel has no trajectory row - recording the'
            + ' frames playing through was lost with the record button');
    }
    if (!/toggleRecording\(\)/.test(body)) {
        throw new Error('the panel\'s trajectory row does not call'
            + ' toggleRecording()');
    }
    if (!/frames\.length > 1/.test(body)) {
        throw new Error('the trajectory row is not gated on there being frames'
            + ' to play - it would offer recording a single-frame structure,'
            + ' which is what the old button did before it disabled itself');
    }
    // ...and the gate must be LIVE. Checking only that the strings are present
    // passed with the row disabled outright (`if (false)`), which is the whole
    // failure this test exists to catch.
    if (!/if \(canTraj\) \{/.test(body)) {
        throw new Error('the trajectory row is not emitted under `if (canTraj)`'
            + ' - the gate is dead, so the row never appears');
    }
});

// EVERY CONTROL IN THE PANEL IS THE SAME HEIGHT. The numbers were 46x24 at
// 12px, too small to read and - worse - a different weight from the row beside
// them, so with a video row and the still row both up it was not obvious which
// field belonged to which output. Reported directly.
t('the save panel sizes its controls consistently', () => {
    const m = src.match(/\n        _toggleSaveImagePanel\s*\(/);
    const body = src.slice(m.index, src.indexOf('\n        }\n', m.index));
    const H = body.match(/const H = (\d+);/);
    if (!H) throw new Error('the panel has no single control height');
    const h = Number(H[1]);
    if (h < 26) {
        throw new Error('the panel\'s controls are ' + h + 'px high - under 26'
            + ' they are hard to read and hard to hit');
    }
    // the number fields and the buttons must both be built from it, or they
    // drift apart again the next time one of them is touched
    for (const [name, re] of [['NUM', /const NUM = `[^`]*height:\$\{H\}px;/],
        ['BTN', /const BTN = `[^`]*/]]) {
        if (!re.test(body)) throw new Error(name + ' is not derived from H');
    }
    if (!/height:\$\{H\}px/.test(body.slice(body.indexOf('const BTN')))) {
        throw new Error('BTN does not take its height from H, so the buttons'
            + ' and the fields can end up different sizes');
    }
    // the old field sizing specifically, not any 46px anywhere: the row-name
    // label legitimately uses that width, and matching it made this fail on a
    // correct build
    if (/const NUM = [^;]*width:46px/.test(body)
        || /const NUM = [^`]*height:24px/.test(body)
        || /const CAP = 'font-size:11px/.test(body)) {
        throw new Error('the panel still has the old cramped field sizing');
    }
});

// No page ships a record button any more; the Save panel is the one way in.
t('no page offers a separate record button', () => {
    for (const f of ['index.html', 'msa.html', 'py2Dmol/resources/viewer.html']) {
        const html = fs.readFileSync(f, 'utf8');
        if (/id="recordButton"/.test(html)) {
            throw new Error(f + ' still has a record button - two entry points'
                + ' for "make a video" is what made this confusing');
        }
    }
});


// BASES ARE PER NUCLEOTIDE NOW, chosen from the selection like side chains
// rather than by one global checkbox.
//
// THE DEFAULT RUNS THE OPPOSITE WAY from side chains, and that asymmetry is the
// whole risk in this feature. Side chains: null means NONE, because they have
// always been off until asked for. Bases: null means ALL, because a duplex has
// always been drawn with its rungs and an object nobody has touched has to keep
// them. An EMPTY set is therefore meaningful - it says every plate was hidden -
// and is not the same as null.
function baseViewer(types) {
    const v = new Cls();
    v.currentObjectName = 'obj';
    v.objectsData = { obj: {} };
    v.positionTypes = types;
    return v;
}

t('the Bases row is offered only where there are nucleotides', () => {
    const v = baseViewer(['P', 'P', 'D', 'R', 'L']);
    if (v.hasBasesFor([0, 1])) throw new Error('offered for a protein selection');
    if (v.hasBasesFor([4])) throw new Error('offered for a ligand');
    if (!v.hasBasesFor([2])) throw new Error('not offered for DNA');
    if (!v.hasBasesFor([3])) throw new Error('not offered for RNA');
    if (!v.hasBasesFor([0, 3])) throw new Error('not offered for a mixed selection');
});

t('hiding a base starts from ALL of them, not from none', () => {
    const v = baseViewer(['D', 'D', 'D', 'P']);
    // untouched: no set at all, which the renderer reads as every base showing
    if (v.objectsData.obj.bases) throw new Error('a set existed before anything asked');
    if (!v.setBasesFor([1], false)) throw new Error('hiding one base changed nothing');
    const b = v.objectsData.obj.bases;
    if (!(b instanceof Set)) throw new Error('no set was materialised');
    // the point: hiding ONE leaves the other two showing. Materialising an
    // empty set instead would hide everything but the ones later added, which
    // is the reverse of what the button says.
    if (b.has(1)) throw new Error('the hidden base is still in the set');
    if (!b.has(0) || !b.has(2)) {
        throw new Error('hiding one base hid the others too - the set was'
            + ' materialised empty instead of full');
    }
    if (b.has(3)) throw new Error('a protein residue was added to the base set');
});

t('hiding every base leaves an empty set, not a missing one', () => {
    const v = baseViewer(['D', 'R']);
    v.setBasesFor([0, 1], false);
    const b = v.objectsData.obj.bases;
    if (!(b instanceof Set) || b.size !== 0) {
        throw new Error('hiding everything did not leave an empty set - absent'
            + ' would read as "all showing", the opposite of what was asked');
    }
    // and showing one again brings back exactly one
    if (!v.setBasesFor([0], true)) throw new Error('showing a base changed nothing');
    if (v.objectsData.obj.bases.size !== 1) {
        throw new Error('showing one base after hiding all gave '
            + v.objectsData.obj.bases.size);
    }
});

t('setBasesFor reports whether anything actually changed', () => {
    const v = baseViewer(['D', 'D']);
    if (v.setBasesFor([0], true)) {
        throw new Error('showing an already-shown base reported a change, so'
            + ' every click would force a redraw');
    }
    if (v.setBasesFor([], false)) throw new Error('an empty selection reported a change');
    const w = baseViewer(['P']);
    if (w.setBasesFor([0], false)) {
        throw new Error('hiding the base of a protein residue reported a change');
    }
    // ...and SHOWING one must not add it either. Without the type filter this
    // is the case that slips through: hiding a non-base is a no-op anyway
    // (it was never in the set), so only the show direction proves the filter
    // is there.
    const x = baseViewer(['P', 'D']);
    x.setBasesFor([0], true);
    const xb = x.objectsData.obj.bases;
    if (xb && xb.has(0)) {
        throw new Error('a protein residue was added to the base set - the'
            + ' position-type filter is gone, so Show would claim to give a'
            + ' base plate to something that has no base');
    }
});

// The renderer must read the set, and must read ABSENT as all - otherwise every
// nucleic structure ever saved comes back with no rungs.
t('the renderer draws every base until a selection says otherwise', () => {
    const cs = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/bases instanceof Set/.test(cs)) {
        throw new Error('viewer-cartoon.js does not consult objectsData[..].bases');
    }
    if (!/!baseSet \|\| baseSet\.has\(res\)/.test(cs)) {
        throw new Error('the renderer does not read an absent set as "all bases"');
    }
    if (!/baseShown\(i\)/.test(cs) || !/baseShown\(j\)/.test(cs)) {
        throw new Error('one half of a pair is not gated - hiding one base of a'
            + ' duplex has to leave its partner alone');
    }
});

t('the global Bases checkbox is gone from the style panel', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    if (/id="basePlatesCheckbox"/.test(html)) {
        throw new Error('index.html still has the global Bases checkbox - it'
            + ' moved to the selection tools');
    }
    // ...and the plate is offered where it belongs: as one of the side-chain
    // modes on the selection panel, not as a row of its own
    if (!/id="sidechainModeSelect"/.test(html) || !/value="plate"/.test(html)) {
        throw new Error('the selection tools cannot draw a base plate');
    }
});


// THE TOGGLE BUTTONS ARE ONE BLOCK, in two rows of three:
//
//     Smooth   Arrows   Cyclic
//     Colorblind  Dark  Draw
//
// Smooth and Arrows used to sit up among the sliders and Cyclic was in the
// FETCH panel, where it read as something that had to be decided before the
// file arrived - it is not: it is a question about the structure that can be
// asked at any time. Three cells per row is also what makes the two line up.
t('the style toggles are grouped together, three to a row', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const at = (id) => html.indexOf('id="' + id + '"');
    const ids = ['smoothCheckbox', 'arrowsCheckbox', 'detectCyclicCheckbox',
        'colorblindCheckbox', 'darkCheckbox', 'drawCheckbox'];
    const pos = ids.map(at);
    ids.forEach((id, k) => {
        if (pos[k] < 0) throw new Error(id + ' is gone from index.html');
    });
    for (let k = 1; k < pos.length; k++) {
        if (pos[k] < pos[k - 1]) {
            throw new Error('the toggles are out of order at ' + ids[k]
                + ': expected ' + ids.join(', '));
        }
    }
    // exactly one row boundary between Cyclic and Colorblind - i.e. they are
    // consecutive rows with nothing in between
    const between = html.slice(pos[2], pos[3]);
    if ((between.match(/class="toggle-item/g) || []).length !== 1) {
        throw new Error('a control row separates the two toggle rows, so they'
            + ' no longer read as one block');
    }
});

// BOTH DEFAULT TO THE GPU. The Python viewer held out while the GPU only drove
// the cartoon; it drives the tube too now, so the conservative default was
// costing a notebook the same 1,813 ms -> 455 on a capsid's first render, and
// 840 ms -> 26 on every frame after it, that the page already had.
//
// Safe in both because it is only ever a REQUEST: the control removes itself
// when WebGL2 is absent, the renderer falls back to the 2D path for anything
// the GPU declines, and PNG/SVG export goes through 2D whatever it says.
t('the GPU is on by default, on the page and in the Python viewer', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const m = html.match(/<input[^>]*id="useGpuCheckbox"[^>]*>/);
    if (!m) throw new Error('the Use GPU checkbox is gone from index.html');
    if (!/\bchecked\b/.test(m[0])) {
        throw new Error('the web app no longer defaults to the GPU: '
            + 'a capsid then draws its first frame on the 2D path, 1.8 s '
            + 'against 0.3, and every frame after it 840 ms against 26');
    }
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    if (!/"gpu":\s*True/.test(py)) {
        throw new Error('the Python viewer no longer defaults to the GPU');
    }
    if (!/gpu=True/.test(py)) {
        throw new Error("view()'s own default disagrees with DEFAULT_CONFIG");
    }
    // ...and the flag is not called cartoon anything any more: it drives both
    // styles, and the name said otherwise for as long as it only drove one.
    for (const f of ['py2Dmol/resources/viewer-mol.js', 'web/app.js', 'py2Dmol/viewer.py']) {
        if (/cartoonGPU|cartoon_gpu\b/.test(fs.readFileSync(f, 'utf8'))) {
            throw new Error(f + ' still calls the backend flag a cartoon one');
        }
    }
    // ...AND IT IS A GLOBAL SETTING, so it sits with Save and Clear All rather
    // than among the fetch options, where it read as something about the file
    // being loaded.
    const top = html.indexOf('id="saveStateButton"');
    const gpu = html.indexOf('id="useGpuRow"');
    if (!(gpu >= 0 && gpu < top)) {
        throw new Error('Use GPU is no longer beside Save/Clear All - it is a '
            + 'global setting, not a property of the file being fetched');
    }
});

// ALIGN ON A NAMED CHAIN. The alignment used to take the first chain in the
// reference frame and say nothing about it; blank still means exactly that.
t('the alignment chain can be named, and a wrong name is reported', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    if (!/id="alignChainInput"/.test(html)) {
        throw new Error('the Align chain field is gone from index.html');
    }
    const app = fs.readFileSync('web/app.js', 'utf8');
    const i = app.indexOf("const wanted = ");
    if (i < 0) throw new Error('the alignment never reads the field');
    const block = app.slice(i, i + 1600);
    if (!/toUpperCase\(\) === wanted\.toUpperCase\(\)/.test(block)) {
        throw new Error('a chain typed in the other case is not matched');
    }
    if (!/No chain/.test(block)) {
        throw new Error('a name the structure does not have is silently ignored -'
            + ' asking for B and getting A is only noticed later, in a figure');
    }
    // ...and blank must still fall through to the first chain
    if (!/Find first non-empty chain ID/.test(block)) {
        throw new Error('the blank case no longer falls back to the first chain');
    }
});

// Cyclic is NOT cartoon-only, so the tag that hides Smooth and Arrows in tube
// style must sit on those two cells and not on the row - otherwise switching to
// tube takes Cyclic off the screen with them.
t('Cyclic survives a switch to tube style', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const i = html.indexOf('id="smoothCheckbox"');
    const rowStart = html.lastIndexOf('<div class="toggle-item', i);
    const rowEnd = html.indexOf('</div>', html.indexOf('id="detectCyclicCheckbox"'));
    const row = html.slice(rowStart, rowEnd);
    const openTag = row.slice(0, row.indexOf('>') + 1);
    if (/data-style/.test(openTag)) {
        throw new Error('the Smooth/Arrows/Cyclic row is tagged data-style, so'
            + ' tube style hides Cyclic too - the tag belongs on the two'
            + ' cartoon-only cells');
    }
    const cyclicCell = row.slice(row.indexOf('id="detectCyclicCheckbox"') - 400,
        row.indexOf('id="detectCyclicCheckbox"'));
    if (/data-style="cartoon"/.test(cyclicCell.slice(cyclicCell.lastIndexOf('<label')))) {
        throw new Error('the Cyclic cell itself is tagged cartoon-only');
    }
});

// ...and it is no longer in the fetch panel.
t('Cyclic left the fetch panel', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const up = html.indexOf('upload-toggle-item');
    const uploadBlock = html.slice(0, html.indexOf('id="viewerColumn"'));
    if (/upload-toggle-label[^>]*>Detect Cyclic/.test(uploadBlock)) {
        throw new Error('Detect Cyclic is still in the fetch panel');
    }
    void up;
});




// THE HALF-COLOURS RIDE ON THE COLOUR ARRAY THEY WERE COMPUTED WITH.
//
// Colour arrays are CACHED - recomputed only when one is missing, changes
// length, or is explicitly invalidated - and there are two of them, the plain
// one and the pLDDT one. Held in a field of its own, the half-colour list is
// written only by whichever function last ran, so a cached array gets served
// beside halves belonging to a DIFFERENT segment list, or to the other colour
// mode. The halves then land on whatever bond now sits at that index, and
// carbon bonds come out red - reported exactly that way.
t('half-colours cannot be served beside the wrong segments', () => {
    const src2 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (/this\.segmentHalfColors/.test(src2)) {
        throw new Error('the half-colours are back in a field of their own, so a'
            + ' cached colour array can be paired with another segment list');
    }
    const grab = (n) => {
        const i2 = src2.indexOf('\n        ' + n + '(');
        if (i2 < 0) throw new Error('cannot lift ' + n);
        return src2.slice(i2, src2.indexOf('\n        }', i2) + 10);
    };
    const st = src2.match(/\n        static get ELEMENT_COLORS\(\)[\s\S]*?\n        \}/);
    if (!st) throw new Error('ELEMENT_COLORS is gone');
    const C = new Function('DEFAULT_CONTACT_COLOR', 'return class {'
        + grab('_calculateSegmentColors') + grab('_segmentElementHalves')
        + grab('_segmentElementColor') + grab('_colorSegmentPosition') + st[0]
        + ' _getEffectiveColorMode(){return "chain";}'
        + ' getAtomColor(){ return {r:9,g:9,b:9}; }'
        + '}')({ r: 255, g: 255, b: 0 });
    const v = new C();
    v.overlayState = { enabled: false };
    v.sidechainMap = new Map([[0, { owner: 0, el: 'C' }], [1, { owner: 0, el: 'O' }],
        [2, { owner: 0, el: 'C' }], [3, { owner: 0, el: 'C' }]]);

    v.segmentIndices = [{ type: 'L', idx1: 0, idx2: 1, origIndex: 0 }];
    const mixed = v._calculateSegmentColors();
    if (!mixed.halves || !mixed.halves[0]) {
        throw new Error('a two-element bond produced no half-colours');
    }
    if (mixed.halves[0].a.r === mixed.halves[0].b.r) {
        throw new Error('both halves of a carbon-oxygen bond are the same colour');
    }
    // the SAME LENGTH list of all-carbon bonds - the case a length check misses
    v.segmentIndices = [{ type: 'L', idx1: 2, idx2: 3, origIndex: 2 }];
    const plain = v._calculateSegmentColors();
    if (plain.halves[0] !== null) {
        throw new Error('an all-carbon bond was given half-colours');
    }
    // ...and the first array still carries its own, so a cached one is never
    // paired with somebody else's segments
    if (!mixed.halves[0]) {
        throw new Error('the earlier colour array lost its half-colours');
    }
});


// ELEMENT COLOURS CAN BE SWITCHED OFF PER RESIDUE, and are ON by default - so
// the buttons hide rather than reveal. Same asymmetry as Bases and the opposite
// of Side chains: absent means ALL, an empty set means none, and the two must
// stay distinguishable.
function elViewer(owners) {
    const v = new Cls();
    v.currentObjectName = 'obj';
    v.objectsData = { obj: {} };
    v.sidechainOwners = () => new Set(owners);
    v.hasSidechainsFor = (ps) => ps.some((i) => owners.includes(i));
    return v;
}

t('element colours are on until a selection turns them off', () => {
    const v = elViewer([1, 2, 3]);
    if (v.objectsData.obj.elements) throw new Error('a set existed before anything asked');
    if (!v.setElementsFor([2], false)) throw new Error('hiding one changed nothing');
    const e = v.objectsData.obj.elements;
    if (!(e instanceof Set)) throw new Error('no set was materialised');
    if (e.has(2)) throw new Error('the hidden residue is still in the set');
    if (!e.has(1) || !e.has(3)) {
        throw new Error('hiding one residue hid the others - the set was'
            + ' materialised empty instead of full');
    }
    // ...and only residues that HAVE side chains take part. Hiding a residue
    // without one is a no-op either way, so only the SHOW direction proves the
    // filter is there - the same blind spot the Bases test had.
    const w = elViewer([1]);
    w.setElementsFor([7], true);
    if (w.objectsData.obj.elements && w.objectsData.obj.elements.has(7)) {
        throw new Error('a residue with no side chain was added to the element'
            + ' set - there is nothing there to colour');
    }
});

t('turning element colours off actually stops the colouring', () => {
    // the switch has to reach _segmentElementHalves, or the buttons do nothing
    const v = elViewer([0]);
    v.sidechainMap = new Map([[10, { owner: 0, el: 'C' }], [11, { owner: 0, el: 'O' }]]);
    const seg = { idx1: 10, idx2: 11 };
    const before = v._segmentElementHalves(seg);
    if (!before || !before.b) throw new Error('a carbon-oxygen bond has no element colours');
    v.setElementsFor([0], false);
    const after = v._segmentElementHalves(seg);
    if (after) {
        throw new Error('the bond still takes element colours after they were'
            + ' switched off for its residue');
    }
    // ...and back on again
    v.setElementsFor([0], true);
    if (!v._segmentElementHalves(seg)) throw new Error('switching back on did nothing');
});

t('the Elements row is offered where side chains are', () => {
    const v = elViewer([4]);
    if (!v.hasElementsFor([4])) throw new Error('not offered for a residue with a side chain');
    if (v.hasElementsFor([9])) throw new Error('offered where there is no side chain');
    const html = fs.readFileSync('index.html', 'utf8');
    if (!/id="elementsShowToggle"/.test(html)) {
        throw new Error('the side-chain row has no Elements toggle');
    }
});


// A TOGGLE SHOWS THE SELECTION'S STATE, AND A MIXED SELECTION IS ITS OWN STATE.
//
// This is the whole reason the +/- pairs went: a pair shows nothing about what
// is currently drawn, so a selection already showing its side chains looked
// exactly like one that was not. A set can be all, none, or SOME - and "some"
// is neither, so it reads indeterminate rather than picking a side. Clicking an
// indeterminate box checks it, which resolves the mixture by turning everything
// on: what "show what I picked" means when half of it already is.
t('the selection toggles show all, none and mixed', () => {
    const nodes = {
        selectionTools: { classList: { toggle() {} }, querySelectorAll: () => [] },
        selectionPanel: { hidden: null }, selectionPanelCount: { textContent: null },
        contactRow: { hidden: null }, clearAllResidues: { disabled: null },
        contactColorButton: { hidden: null, parentElement: { hidden: null } },
        contactWidthSlider: { hidden: null, value: null },
        sidechainRow: { hidden: null },
        sidechainModeSelect: modeSelectNode(),
        sidechainShowToggle: { checked: false, indeterminate: false, hidden: null },
        elementsShowToggle: { checked: false, indeterminate: false },
        mainchainShowToggle: { checked: false, indeterminate: false },
        contactShowToggle: { checked: false, indeterminate: false },
    };
    const owners = new Set([1, 2, 3]);
    const run = (picked, shown) => {
        const f = new Function('document', 'getActiveSelection', 'viewerApi',
            'findContact', 'contactSlots',
            panelBody + '; return updateSelectionToolsState;')(
            { getElementById: (id) => nodes[id] || null },
            () => picked,
            { renderer: {
                hasSidechainsFor: (p2) => p2.some((i) => owners.has(i)),
                hasElementsFor: (p2) => p2.some((i) => owners.has(i)),
                hasBasesFor: () => false,
                sidechainOwners: () => owners,
                positionTypes: [], visiblePositions: null,
                currentObjectName: 'obj',
                objectsData: { obj: { sidechains: shown } },
            } },
            () => null, () => ({ w: 4, col: 5 }));
        f();
        return nodes.sidechainModeSelect;
    };
    let t2 = run([1, 2], new Set([1, 2]));
    if (t2.value !== 'full') throw new Error('all shown did not read as full');
    t2 = run([1, 2], new Set());
    if (t2.value !== 'none') throw new Error('none shown did not read as none');
    t2 = run([1, 2], new Set([1]));
    if (t2.value !== '') {
        throw new Error('a MIXED selection did not read as mixed - it was shown as "'
            + t2.value + '", which is a lie about half of what was picked');
    }
    // ...and with nothing selected the control reads blank rather than stale
    t2 = run([], new Set([1, 2]));
    if (t2.value !== '') throw new Error('an empty selection left a stale state');
});

// Elements default ON, so their toggle must read on for an untouched object -
// the opposite of side chains, and the asymmetry is easy to lose.
t('the Elements toggle reads on until it is switched off', () => {
    const nodes = {
        selectionTools: { classList: { toggle() {} }, querySelectorAll: () => [] },
        selectionPanel: { hidden: null }, selectionPanelCount: { textContent: null },
        contactRow: { hidden: null }, clearAllResidues: { disabled: null },
        contactColorButton: { hidden: null, parentElement: { hidden: null } },
        contactWidthSlider: { hidden: null, value: null },
        sidechainRow: { hidden: null }, basesRow: { hidden: null },
        sidechainShowToggle: { checked: false, indeterminate: false },
        elementsShowToggle: { checked: false, indeterminate: false },
        basesShowToggle: { checked: false, indeterminate: false },
        mainchainShowToggle: { checked: false, indeterminate: false },
        contactShowToggle: { checked: false, indeterminate: false },
    };
    const owners = new Set([1, 2]);
    const run = (objData) => {
        new Function('document', 'getActiveSelection', 'viewerApi', 'findContact',
            'contactSlots', panelBody + '; return updateSelectionToolsState;')(
            { getElementById: (id) => nodes[id] || null }, () => [1, 2],
            { renderer: {
                hasSidechainsFor: () => true, hasElementsFor: () => true,
                hasBasesFor: () => false, sidechainOwners: () => owners,
                positionTypes: [], visiblePositions: null,
                currentObjectName: 'obj', objectsData: { obj: objData },
            } }, () => null, () => ({ w: 4, col: 5 }))();
        return nodes.elementsShowToggle;
    };
    if (!run({}).checked) {
        throw new Error('an untouched object reads element colours as OFF - absent'
            + ' means all, so it must read on');
    }
    if (run({ elements: new Set() }).checked) {
        throw new Error('an EMPTY set reads as on - empty means none, and it has to'
            + ' stay distinguishable from absent');
    }
    if (!run({ elements: new Set([1]) }).indeterminate) {
        throw new Error('half switched off did not read as mixed');
    }
});

// The same stale index, from the panel's side: the renderer prunes it, and this
// is the second lock on the same door. An index past the end of the coordinate
// array is not a hidden position - it is not a position at all - so it must not
// be tallied at all rather than tallied as "not visible".
t('the toggles ignore a selected position that no longer exists', () => {
    const nodes = {
        selectionTools: { classList: { toggle() {} }, querySelectorAll: () => [] },
        selectionPanel: { hidden: null }, selectionPanelCount: { textContent: null },
        contactRow: { hidden: null }, clearAllResidues: { disabled: null },
        contactColorButton: { hidden: null, parentElement: { hidden: null } },
        contactWidthSlider: { hidden: null, value: null },
        sidechainRow: { hidden: null }, basesRow: { hidden: null },
        sidechainShowToggle: { checked: false, indeterminate: false },
        elementsShowToggle: { checked: false, indeterminate: false },
        basesShowToggle: { checked: false, indeterminate: false },
        mainchainShowToggle: { checked: false, indeterminate: false },
        contactShowToggle: { checked: false, indeterminate: false },
    };
    const run = (picked) => {
        new Function('document', 'getActiveSelection', 'viewerApi', 'findContact',
            'contactSlots', panelBody + '; return updateSelectionToolsState;')(
            { getElementById: (id) => nodes[id] || null }, () => picked,
            { renderer: {
                hasSidechainsFor: () => true, hasElementsFor: () => true,
                hasBasesFor: () => false, sidechainOwners: () => new Set([1, 2]),
                positionTypes: [], coords: new Array(6),
                visiblePositions: new Set([0, 1, 2, 3, 4, 5]),
                currentObjectName: 'obj', objectsData: { obj: {} },
            } }, () => null, () => ({ w: 4, col: 5 }))();
        return nodes.mainchainShowToggle;
    };
    if (!run([1, 2]).checked) throw new Error('a fully visible selection did not read as on');
    const t2 = run([1, 2, 99]);
    if (t2.indeterminate || !t2.checked) {
        throw new Error('index 99 - past the end of a 6-position structure - was'
            + ' counted as hidden, so the main chain read as half hidden');
    }
});

// A SELECTOR THAT NAMES ELEMENT TYPES ROTS WHEN THE ELEMENTS CHANGE TYPE. The
// panel disabled `button, select` so its controls leave the tab order with no
// selection - and the +/- buttons then became checkboxes, which that selector
// does not match. Nothing failed: the toggles simply stayed live.
t('the show toggles are disabled along with the rest of the panel', () => {
    const toggles = [{ tag: 'INPUT', disabled: false }, { tag: 'INPUT', disabled: false }];
    const buttons = [{ tag: 'BUTTON', disabled: false }];
    const nodes = {
        selectionTools: {
            classList: { toggle() {} },
            // the real DOM answers by SELECTOR, so the stub must too
            querySelectorAll: (sel) => [
                ...(/button/i.test(sel) ? buttons : []),
                ...(/input/i.test(sel) ? toggles : []),
            ],
        },
        selectionPanel: { hidden: null }, selectionPanelCount: { textContent: null },
        contactRow: { hidden: null }, clearAllResidues: { disabled: null },
        contactColorButton: { hidden: null, parentElement: { hidden: null } },
        contactWidthSlider: { hidden: null, value: null },
        sidechainRow: { hidden: null }, basesRow: { hidden: null },
        sidechainShowToggle: { checked: false, indeterminate: false },
        elementsShowToggle: { checked: false, indeterminate: false },
        basesShowToggle: { checked: false, indeterminate: false },
        mainchainShowToggle: { checked: false, indeterminate: false },
        contactShowToggle: { checked: false, indeterminate: false },
    };
    const run = (picked) => new Function('document', 'getActiveSelection', 'viewerApi',
        'findContact', 'contactSlots', panelBody + '; return updateSelectionToolsState;')(
        { getElementById: (id) => nodes[id] || null }, () => picked,
        { renderer: {
            hasSidechainsFor: () => true, hasElementsFor: () => true,
            hasBasesFor: () => false, sidechainOwners: () => new Set([1]),
            positionTypes: [], coords: new Array(6), visiblePositions: null,
            currentObjectName: 'obj', objectsData: { obj: {} },
        } }, () => null, () => ({ w: 4, col: 5 }))();
    run(null);
    if (!toggles.every((e) => e.disabled)) {
        throw new Error('a checkbox stayed enabled with nothing selected - it is'
            + ' still tabbable and still clickable');
    }
    if (!buttons.every((e) => e.disabled)) throw new Error('the buttons stayed enabled');
    run([1]);
    if (toggles.some((e) => e.disabled) || buttons.some((e) => e.disabled)) {
        throw new Error('the panel stayed disabled WITH a selection, so the check'
            + ' above only proves everything is dead');
    }
});

// THREE OF THESE READ "Show". A sighted user tells them apart by the row label
// beside them; a screen reader announces the control on its own, so without a
// name of its own each is just "Show, checkbox" three times over. The +/- pair
// carried aria-labels for the same reason and they went with the buttons.
t('every selection toggle has a name of its own', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const ids = ['sidechainShowToggle', 'elementsShowToggle', 'mainchainShowToggle',
        'contactShowToggle'];
    const seen = new Set();
    for (const id of ids) {
        const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
        if (!m) throw new Error('no input for ' + id);
        const label = (m[0].match(/aria-label="([^"]+)"/) || [])[1];
        if (!label) throw new Error(id + ' has no aria-label: it is announced by its'
            + ' visible text, and three of these say only "Show"');
        if (seen.has(label)) throw new Error('two toggles share the name "' + label + '"');
        seen.add(label);
    }
    // the side-chain mode is a select and needs the same
    const sel = html.match(/<select[^>]*id="sidechainModeSelect"[^>]*>/);
    if (!sel) throw new Error('no sidechainModeSelect');
    if (!/aria-label="/.test(sel[0])) throw new Error('the mode select has no name');
    for (const v of ['none', 'plate', 'full']) {
        if (!new RegExp('value="' + v + '"').test(html)) {
            throw new Error('the mode select has no ' + v + ' option');
        }
    }
});

// ---------------------------------------------------------------------------
// WHAT A FRAME COSTS, which is the whole of the gesture decision. Lifted out of
// the cartoon plugin as source text, for the usual reason: a paraphrase of a
// cost estimator agrees with itself forever.
// Anchored STRUCTURALLY - the costKey line and the `if (!cacheRebuilt)` block,
// brace-matched - rather than on the text of any expression inside it. An
// earlier version ended the slice on the ratio expression, so editing that
// expression did not fail a test, it stopped the suite from loading at all.
// Built lazily for the same reason: a missing anchor must FAIL, not crash.
let _costRecorder;
const costRecorder = (...args) => {
    if (!_costRecorder) {
        const cSrc = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
        const key = cSrc.indexOf('const costKey = `${renderer.currentObjectName}');
        if (key < 0) throw new Error('the costKey line moved - nothing here scores it');
        const a = cSrc.lastIndexOf('{', key);          // the block it opens
        const rec = cSrc.indexOf('if (!cacheRebuilt) {', a);
        if (rec < 0) throw new Error('the cost-recording block moved');
        let d = 0, k = cSrc.indexOf('{', rec);
        for (; k < cSrc.length; k++) {
            if (cSrc[k] === '{') d++;
            else if (cSrc[k] === '}' && !--d) break;
        }
        _costRecorder = new Function('renderer', 'n', '_t0', 'cacheRebuilt',
            'performance', cSrc.slice(a, k + 1));
    }
    return _costRecorder(...args);
};

// one frame: `ms` is what it cost, `inked` whether the outline was drawn
const frame = (r, ms, inked, opts = {}) => {
    r._inkRan = inked;
    costRecorder(r, opts.n === undefined ? 100 : opts.n, 0,
        !!opts.cacheRebuilt, { now: () => ms });
};
const mkCostRenderer = () => ({ currentObjectName: 'obj',
    displayWidth: 900, displayHeight: 900 });

// EVERY SOURCE OF NOISE IN A FRAME TIME IS ONE-SIDED. JIT, a cold cache, a GC
// pause, another process taking the CPU - all of them only make a frame slower.
// So the cheapest of the last five is the frame's real cost and the dearer ones
// are that cost plus an accident, which is why the estimate is the minimum. The
// median let a RUN of consecutive cold frames - exactly how warm-up arrives -
// carry the whole window: measured on 1UBQ, 27.7 ms on the first drag against
// 6.1 on the second, with nothing about the structure changed.
t('the frame-cost estimate is the cheapest of the last five, not the median', () => {
    const r = mkCostRenderer();
    // a warm-up run followed by steady frames, which is what a drag looks like
    for (const ms of [40, 40, 40, 8, 9]) frame(r, ms, true);
    if (r._lastInkedMs !== 8) {
        throw new Error('estimate is ' + r._lastInkedMs + ' ms, want 8 - the median'
            + ' of this window is 40, which is three cold frames deciding a drag');
    }
    // and it must still be a WINDOW: the cheap frames age out, so a structure
    // that gets dearer - a zoom in, a style change - is not held to a price it
    // no longer costs
    for (const ms of [30, 31, 32, 33, 34]) frame(r, ms, true);
    if (r._lastInkedMs !== 30) {
        throw new Error('a sample outside the last five still counts: got ' + r._lastInkedMs);
    }
});

// THE SAME STRUCTURE MUST NOT DECIDE DIFFERENTLY DRAG TO DRAG. This is the
// reported symptom - "similar sized objects, I jump between slow and fast" -
// and it is reproduced here as the sequence a real gesture produces: a few cold
// frames, then steady ones, repeated. The estimate must land on the steady cost
// each time rather than on whichever population happens to fill the window.
t('repeated drags on one structure reach the same verdict', () => {
    const BUDGET = 25;
    const verdicts = [];
    const r = mkCostRenderer();
    for (let drag = 0; drag < 4; drag++) {
        // warm-up frames arrive CONSECUTIVELY, then the drag settles
        for (const ms of [38, 36, 34]) frame(r, ms, true);
        for (const ms of [9, 10, 9, 11]) frame(r, ms, true);
        verdicts.push(r._lastInkedMs > BUDGET);
    }
    if (verdicts.some((v) => v !== verdicts[0])) {
        throw new Error('the same structure was judged ' + JSON.stringify(verdicts)
            + ' over four identical drags');
    }
    if (verdicts[0]) throw new Error('a 9 ms structure was called unaffordable');
});

// COST IS PER PIXEL AS MUCH AS PER STRUCTURE. Keyed on the object alone, samples
// taken at 900px stayed in place to decide frames at 1400px - 2.4x the work.
t('the cost history is thrown away when the canvas changes size', () => {
    const r = mkCostRenderer();
    for (const ms of [4, 4, 4]) frame(r, ms, true);
    if (r._lastInkedMs !== 4) throw new Error('history did not fill');
    r.displayWidth = 1400; r.displayHeight = 1400;
    frame(r, 40, true);
    if (r._lastInkedMs !== 40) {
        throw new Error('a 900px sample survived the resize and is deciding 1400px'
            + ' frames: estimate ' + r._lastInkedMs);
    }
    // ...but not for a nudge of a few pixels, or a resize drag clears it every frame
    r.displayWidth = 1402;
    frame(r, 41, true);
    if (r._lastInkedMs !== 40) {
        throw new Error('a 2px change wiped the history - a resize drag would leave'
            + ' it permanently empty');
    }
});

// A FRAME THAT ALSO DRAWS THE INK CANNOT BE CHEAPER THAN THE SAME FRAME WITHOUT
// IT. The two sides of this ratio are taken from different moments, so the raw
// quotient went as low as 0.77 in measurement - and below 1 it makes the
// degraded estimate cheaper than the bare frame it is built from, which brings
// the outline back onto a frame that cannot afford it.
t('the ink-cost ratio can never say ink is free', () => {
    const r = mkCostRenderer();
    for (const ms of [20, 21, 22]) frame(r, ms, false);   // bare frames
    for (const ms of [10, 11, 12]) frame(r, ms, true);    // inked, and CHEAPER
    if (!(r._inkRatio >= 1)) {
        throw new Error('ratio is ' + r._inkRatio + ' - the estimate while degraded'
            + ' is now cheaper than the bare frame it multiplies');
    }
});

console.log(fail ? ('FAILURES '+fail):'all '+pass+' checks passed');
process.exit(fail?1:0);
