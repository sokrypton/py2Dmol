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
    'SELECTION_HALO_MIN_PX', 'SELECTION_HALO_RADIUS_FRAC', 'SIDECHAIN_WIDTH', 'SIDECHAIN_REACH_A',
    'PICK_WIDTH_SCALE', 'CONTACT_WIDTH_A', 'HOVER_TEXT_LIGHT_CSS',
    'HOVER_TEXT_DARK_CSS', 'HOVER_TEXT_MARGIN']) {
    const line = molSrc.split('\n').find((l) => l.trim().startsWith('const ' + name + ' ='));
    if (!line) throw new Error('constant not found in viewer-mol.js: ' + name);
    eval('global.' + line.trim().replace('const ', ''));
}
// ...and Vec3, which some of them construct (a view centre with no object is
// new Vec3(0, 0, 0)). Same reasoning as the constants: taken from the source
// so the test scores the shipped class.
{
    const at = molSrc.indexOf('class Vec3 {');
    if (at < 0) throw new Error('Vec3 not found in viewer-mol.js');
    let d = 0; let k = molSrc.indexOf('{', at);
    for (; k < molSrc.length; k++) {
        if (molSrc[k] === '{') d++; else if (molSrc[k] === '}' && !--d) break;
    }
    eval('global.Vec3 = ' + molSrc.slice(at, k + 1).replace('class Vec3', 'class'));
}
// ...and the module-level FUNCTIONS they call, for the same reason: a lifted
// method that reaches one of these gets a ReferenceError, which reads as ten
// unrelated halo tests breaking at once.
for (const name of ['selectionBandFor']) {
    const at = molSrc.indexOf('function ' + name + '(');
    if (at < 0) throw new Error('function not found in viewer-mol.js: ' + name);
    eval('global.' + name + ' = ' + molSrc.slice(at, molSrc.indexOf('\n    }', at) + 6)
        .replace('function ' + name, 'function'));
}
// orient's rotation solver, scored as shipped
eval(fs.readFileSync('web/utils.js','utf8').match(
  /function bestViewTargetRotation_relaxed_AUTO[\s\S]*?\n\}\n/)[0]);
const names=['_inertiaAllowed','_frameOverBudget','smoothAnimationOk','_scheduleSettle','_materialiseSidechains','pickGroupAt','selectionInk','_remapSidechains','_colorPositionFor','_sidechainColorOf','_colorSegmentPosition','_syncSaveButtonMode','hasBasesFor','setBasesFor','captureOpts','videoFormats','videoFormatOf','videoSizes','_makeVideoSink','hasElementsFor','setElementsFor','forcedSseFor','assignedSseFor','sidechainOwners','elementOwners','elementAt','_elementOwnerOf','_segmentElementHalves','_paintSelectionHalo','_paintOverlays','_paintHoverReadout','hoverSet','_snapshotCleanFrame','clipSlabDefault','clipViewExtent','setClipSlab','clipSlabOn','clipAccepts','clipCoverage','clipFadeWidth','setClipFade','_clipReach','clipSlabForSelection','_applyStyleDefaults','autoClip','_autoClipDepth','_refreshAutoClip','residuesWithin','_atomsOfResidues','_isSidechainSegment','backboneHiddenSet','backboneHiddenAt','setBackboneHiddenFor','framingPositions','showAll','resetVisibility','_repaintOverlays','setHover','_calculateSegmentWidthMultiplier','sidechainOwners','hasSidechainsFor','_shadowPairExcluded','_resolveContactToIndices','pickResidueAt','_pickable','beginSelectionPreview','updateSelectionPreview','endSelectionPreview','_invalidateSelectionPreview','_ensurePickProjection','_projectForPicking','_rotateCoords','_computeViewCentre','_gpuWillDraw','_tubeGPUWillTake','_gpuWillTake','_ensureRotated','drawnObjects','_resolvePlddtData','_resolvedFrame','_mergeObjects','_mergeSidechainTables','_hasPlddtData','sourceGroups','shownSidechainSet','sourceOffsetOf','setShownObjects','_applyShownObjects','drawnStats','_mergedStats','_applyMergedVisibility','ownerOf','mergedObjectSet','writeGroups','localRangeOf','_positionCount','mergedLigandGroups','_autoColorFor','chainColorKeyAt','chainColorKeyFor','selectionForObject','_maskForObject','_editOneObject','objectSwatch','addObject',];
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
const statics=['ELEMENT_COLORS','CAPTURE_DEFAULTS','GIF_LIMITS'].map((nm)=>
 (src.match(new RegExp('\\n        static get '+nm+'\\(\\)[\\s\\S]*?\\n        \\}'))||[''])[0]).join('\n');
const Cls=new Function('document','window','return class V {'+names.map(n=>body[n]).join('\n')+statics+'}')
 ({createElement:()=>mkCanvas(0,0)}, global.window);
function mkCtx(canvas){const ops=[];return {ops,canvas,fillStyle:'',
 setTransform(){ops.push(['setTransform']);},save(){},restore(){},
 clearRect(){ops.push(['clearRect']);},fillRect(){ops.push(['fillRect']);},
 drawImage(img,x,y,w,h){ops.push(['drawImage',x,y,w,h]);},
 // ...the two a capture sink reads back through
 getImageData(x,y,w,h){return {data:new Uint8ClampedArray(4*Math.max(1,w)*Math.max(1,h))};}};}
function mkCanvas(w,h){const c={width:w,height:h,style:{}};
 c.getContext=()=>c._c||(c._c=mkCtx(c));
 // A CANVAS A RECORDING CAN BE MADE FROM. The sink captures a stream from it
 // and, for the Images format, asks it for a PNG - neither of which a bare
 // {width,height} does, which is why nothing in this file could build a sink.
 c.toBlob=(cb)=>cb({size:10,type:'image/png'});
 c.captureStream=()=>({getVideoTracks:()=>[{requestFrame(){}}],
  getTracks:()=>[{stop(){}}]});
 return c;}
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
        + '\n' + lift('describeSelectionRanges')
        // ...and the two the toggles read: which of them is a ligand row, and
        // how much of it is drawn
        + '\n' + lift('ligandRowPositions') + '\n' + lift('visibleState')
        + '\n' + lift('syncSseSelect');
})();
// The Plate switch, as much of one as the panel touches: checked, mixed, and a
// label that carries the word (the checkbox itself is invisible).
function plateToggleNode() {
    const label = { hidden: null };
    return { checked: false, indeterminate: false, hidden: null,
        closest: () => label, label };
}
function panelRun(selection, sidechained = new Set(), hasContact = false, types = null,
    shown = null, ligEls = new Set(), visible = null, sse = null, basesOff = null,
    scMap = null) {
    const nodes = {
        selectionTools: { classList: { toggle(c, on) { this._on = on; } } },
        selectionPanel: { hidden: null },
        selectionPanelCount: { textContent: null },
        contactRow: { hidden: null },
        clearAllResidues: { disabled: null },
        elementsShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
        mainchainShowToggle: { checked: false, indeterminate: false },
        plateShowToggle: plateToggleNode(),
        sidechainShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
        contactShowToggle: { checked: false, indeterminate: false },
        contactColorButton: { hidden: null, parentElement: { hidden: null } },
        contactWidthSlider: { hidden: null, value: null },
        // the row carries a name and a swatch as well as its controls, and
        // both change when the only thing left on it is a ligand's elements
        mainchainRow: { hidden: null },
        selActionDivider: { hidden: null },
        sidechainRow: (() => {
            const label = { textContent: 'Side chains' };
            const swatch = { hidden: null };
            return { hidden: null, label, swatch,
                querySelector: (sel) => (sel.indexOf('label') >= 0 ? label
                    : (sel.indexOf('color-wrap') >= 0 ? swatch : null)) };
        })(),
        selSsSelect: (() => {
            const opts = { dssp: { textContent: 'DSSP' } };
            return { hidden: null, disabled: null, value: '', title: '', opts,
                querySelector: (q) => {
                    const m = /option\[value="([^"]+)"\]/.exec(q);
                    return m ? opts[m[1]] || null : null;
                } };
        })(),
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
            // a ligand atom owns its own element, with no side chain anywhere
            hasElementsFor: (p2) => p2.some((i) => sidechained.has(i) || ligEls.has(i)),
            elementOwners: () => new Set([...sidechained, ...ligEls]),
            hasBasesFor: (p2) => !!types && p2.some((i) => types[i] === 'D' || types[i] === 'R'),
            hasSseFor: (p2) => (types ? p2.some((i) => types[i] === 'P') : true),
            // 'none' = nothing forced, which is what a structure nobody has
            // touched reads; '' = the selection disagrees
            forcedSseFor: () => (sse ? sse.forced : 'none'),
            assignedSseFor: () => (sse ? (sse.assigned || '') : ''),
            sidechainOwners: () => sidechained,
            // the appended atoms, keyed to the residue each hangs off - the
            // renderer builds this when side chains are materialised
            sidechainMap: scMap,
            positionTypes: types || [],
            // null = everything is drawn, which is what the Show switch on a
            // ligand row reads
            visiblePositions: visible,
            currentObjectName: 'obj',
            // `shown` is what the OBJECT has switched on - obj.sidechains -
            // while `sidechained` is what the structure HAS. The panel reads
            // both, and the side-chain mode is the first of the two.
            // `basesOff` is an empty base set - the object saying "no plates
            // here", which is how a nucleotide with nothing drawn is expressed
            objectsData: { obj: Object.assign({}, shown ? { sidechains: shown } : {},
                basesOff ? { bases: new Set() } : {}) },
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

t('a line separates what the selection IS from what to do with it', () => {
    // The rows above set properties of the picked residues - how they are
    // drawn, what colour, which structure. Find and Contact do something
    // instead: one changes the selection, the other adds an annotation. In one
    // undivided stack of labelled rows, Find read as another property with a
    // button beside it.
    const html = fs.readFileSync('index.html', 'utf8');
    const div = html.indexOf('id="selActionDivider"');
    if (div < 0) throw new Error('the selection panel has no divider');
    const mc = html.indexOf('id="mainchainRow"');
    const find = html.indexOf('id="nearbyRow"');
    if (!(mc < div && div < find)) {
        throw new Error('the divider is not between the property rows and Find');
    }
    const css = fs.readFileSync('web/style.css', 'utf8');
    if (!/\.selection-panel-divider\s*\{[^}]*background/.test(css)) {
        throw new Error('the divider has no line to draw');
    }
    if (!/\.selection-panel-divider\[hidden\]\s*\{\s*display:\s*none/.test(css)) {
        throw new Error('the divider cannot be hidden, and [hidden] is a UA rule'
            + ' that any display value outranks');
    }
    // ...AND IT GOES WHEN THERE IS NOTHING ABOVE IT. Both property rows can be
    // taken away at once - a ligand has no main chain row, and a selection
    // with no elements to colour loses the other - and a rule under nothing is
    // a line across the top of the panel.
    const shown = panelRun([4, 5], new Set([4, 5]), false, null, new Set([4, 5]));
    if (shown.selActionDivider.hidden) {
        throw new Error('the divider is hidden with rows above it');
    }
    const empty = panelRun(null);
    if (!empty.selActionDivider.hidden) {
        throw new Error('the divider is drawn with no selection at all');
    }
});

t('a selection full of side-chain atoms still reads as its residues', () => {
    // SHOWING SIDE CHAINS CHANGES WHAT SELECTING A CHAIN SELECTS. The atoms are
    // appended to the coordinate array as positions of their own and carry
    // their residue's chain, so the next click on that chain picks up both: on
    // 1YNE, 31 residues and 347 atoms. Every question this panel asks is about
    // a RESIDUE, and an atom answers for itself - it has no side chain of its
    // own - so the row came back Mixed immediately after the control that
    // created the atoms was used. Reported exactly that way: select chain,
    // turn on atoms, deselect, select again, Show is banded.
    const residues = [1, 2, 3];
    const atoms = [10, 11, 12, 13];
    const scMap = new Map(atoms.map((a, k) => [a, { owner: residues[k % 3] }]));
    const sel = residues.concat(atoms);
    const n = panelRun(sel, new Set(residues), false, null, new Set(residues),
        new Set(), null, null, null, scMap);
    if (n.sidechainShowToggle.indeterminate) {
        throw new Error('the side-chain switch is Mixed over a selection whose'
            + ' residues all have their atoms shown - the atoms are answering'
            + ' for themselves');
    }
    if (n.sidechainShowToggle.checked !== true) {
        throw new Error('the side chains are shown and the switch says otherwise');
    }
    // and the same for the backbone row, which reads a set atoms are never in
    if (n.mainchainShowToggle.indeterminate) {
        throw new Error('the backbone switch is Mixed because of the atoms');
    }
    // ...while a genuine mixture is still Mixed: one residue on, two off
    const half = panelRun(sel, new Set(residues), false, null, new Set([1]),
        new Set(), null, null, null, scMap);
    if (!half.sidechainShowToggle.indeterminate) {
        throw new Error('a real mixture no longer reads as one');
    }
});

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
    const need = ['plateShowToggle', 'sidechainShowToggle', 'elementsShowToggle',
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

t('the SSE state is read off the structure, forced and assigned apart', () => {
    // The panel shows one letter either way, so these two are what tell the
    // states apart - and only one of them is a promise about what is drawn now.
    const v = new Cls();
    v.currentObjectName = 'obj';
    v.objectsData = { obj: {} };
    v.positionTypes = ['P', 'P', 'P', 'D'];
    v.coords = [0, 0, 0, 0];
    if (v.forcedSseFor([0, 1, 2]) !== 'none') {
        throw new Error('a structure nobody has touched reads as forced');
    }
    v.objectsData.obj.sse = { 0: 'H', 1: 'H' };
    if (v.forcedSseFor([0, 1]) !== 'H') throw new Error('two forced helices did not agree');
    if (v.forcedSseFor([0, 2]) !== '') {
        throw new Error('one forced and one not read as a single state - the menu'
            + ' would then show a letter that half the selection has not got');
    }
    v.objectsData.obj.sse = { 0: 'H', 1: 'E' };
    if (v.forcedSseFor([0, 1]) !== '') throw new Error('helix and sheet agreed');
    // A NUCLEOTIDE IS NOT PART OF THE ANSWER: it can never be forced, so
    // counting it would read every protein-plus-duplex selection as mixed.
    v.objectsData.obj.sse = { 0: 'H', 1: 'H' };
    if (v.forcedSseFor([0, 1, 3]) !== 'H') {
        throw new Error('a nucleotide in the selection made it read as mixed');
    }
    // ...and the assignment, from the cache the drawing fills
    if (v.assignedSseFor([0, 1]) !== '') {
        throw new Error('an assignment was reported with no cache to read - the'
            + ' only other way to get one is to run the whole SS pipeline here');
    }
    v._cartoonSec = ['H', 'H', 'E', 'C'];
    if (v.assignedSseFor([0, 1]) !== 'H') throw new Error('the cached assignment was not read');
    if (v.assignedSseFor([0, 2]) !== '') throw new Error('helix and sheet agreed');
    v._cartoonSec = ['H', 'H'];            // stale: shorter than the coordinates
    if (v.assignedSseFor([0, 1]) !== '') {
        throw new Error('a cache from another structure was read as this one');
    }
});

t('the SSE menu shows the state it is in, not the word SSE', () => {
    // IT READ "SSE" WHATEVER WAS SELECTED. The menu reset itself after every
    // pick, so a panel whose whole job is to say what the selection currently
    // is had one control that never did. Four states and Mixed, the same way
    // the side-chain menu reads back.
    const PROT = ['P', 'P', 'P', 'P'];
    const auto = panelRun([0, 1], new Set(), false, PROT, null, new Set(), null,
        { forced: 'none', assigned: 'H' });
    if (auto.selSsSelect.value !== 'dssp') {
        throw new Error('an unforced selection reads "' + auto.selSsSelect.value
            + '" - nothing is forced there, so DSSP is the state it is in');
    }
    // ...and the automatic answer is IN the option, or the menu says a state
    // without saying what it produced
    if (auto.selSsSelect.opts.dssp.textContent !== 'DSSP (Helix)') {
        throw new Error('the DSSP option does not carry the assignment: '
            + auto.selSsSelect.opts.dssp.textContent);
    }
    const forced = panelRun([0, 1], new Set(), false, PROT, null, new Set(), null,
        { forced: 'E', assigned: 'H' });
    if (forced.selSsSelect.value !== 'E') {
        throw new Error('a selection forced to sheet reads "'
            + forced.selSsSelect.value + '"');
    }
    if (forced.selSsSelect.opts.dssp.textContent !== 'DSSP') {
        throw new Error('the DSSP option advertised an assignment that is being'
            + ' overridden - what is drawn there is the forced letter');
    }
    if (!/Forced to Sheet/.test(forced.selSsSelect.title)) {
        throw new Error('nothing tells forced from assigned: ' + forced.selSsSelect.title);
    }
    // ...and disagreement is a state of its own, shown and not picked
    const mixed = panelRun([0, 1], new Set(), false, PROT, null, new Set(), null,
        { forced: '', assigned: '' });
    if (mixed.selSsSelect.value !== '') {
        throw new Error('a selection with two structures in it picked one');
    }
    // the markup backs that: Mixed is a readout, and Auto is now DSSP
    const html = fs.readFileSync('index.html', 'utf8');
    const m = html.match(/<select id="selSsSelect"[\s\S]*?<\/select>/);
    if (!m) throw new Error('the SSE select is gone from index.html');
    if (/>SSE</.test(m[0])) {
        throw new Error('the placeholder option is back - it is what made the'
            + ' menu say the same thing whatever was selected');
    }
    if (/value="auto"/.test(m[0])) throw new Error('Auto was not renamed');
    if (!/value="dssp"/.test(m[0])) throw new Error('there is no DSSP option');
    if (!/<option value="" disabled hidden>Mixed<\/option>/.test(m[0])) {
        throw new Error('Mixed is missing, or is pickable - there is nothing to'
            + ' DO with mixed');
    }
    // ...and DSSP is the option that takes the override OFF
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/v === 'dssp' \? null : v/.test(app)) {
        throw new Error('picking DSSP no longer clears the forced structure');
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

t('Elements is offered only where there are atoms to colour', () => {
    // A property of ATOMS: on None there is nothing to colour, and a plate is
    // one flat shape with no elements in it. The toggle sat there in both,
    // doing nothing a user could see.
    const PROT = ['P', 'P'];
    const NUC = ['D', 'D'];
    // side chains drawn as atoms - the panel reads Full
    const full = panelRun([0, 1], new Set([0, 1]), false, PROT, new Set([0, 1]));
    if (full.plateShowToggle.checked !== false
        || full.plateShowToggle.label.hidden !== true) {
        throw new Error('the harness did not reach Full on a protein');
    }
    if (full.elementsShowToggle.label.hidden !== false) {
        throw new Error('Elements is hidden while the side chains are drawn');
    }
    // nothing drawn - the switch is off, and there is no style menu to read
    const none = panelRun([0, 1], new Set([0, 1]), false, PROT);
    if (none.sidechainShowToggle.checked !== false) {
        throw new Error('the harness did not reach "not drawn"');
    }
    if (none.elementsShowToggle.label.hidden !== true) {
        throw new Error('Elements is offered with no side chains to colour');
    }
    // a plate has no elements in it either
    const plate = panelRun([0, 1], new Set(), false, NUC);
    if (plate.plateShowToggle.checked !== true) {
        throw new Error('the harness did not reach Plate');
    }
    if (plate.elementsShowToggle.label.hidden !== true) {
        throw new Error('Elements is offered for a base plate');
    }
    // ...and it is the LABEL that hides, or the word stays on the row with no
    // control under it
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/const wrap = elTog\.closest \? elTog\.closest\('label'\) : null;/.test(app)) {
        throw new Error('the checkbox hides on its own, leaving its text behind');
    }
});

t('Show comes first on every row, and the style menu after it', () => {
    // EVERY ROW ON THIS PANEL ANSWERS "IS THIS DRAWN" WITH A SWITCH. The
    // side-chain row answered it with a three-way menu wherever the selection
    // had a nucleotide - so the same question had two shapes depending on what
    // was picked, and None hid inside a list where every other row has a
    // switch. The switch is the question; the menu is the second question,
    // WHICH WAY, and only a nucleotide has two answers to it.
    const NUC = ['D', 'D'];
    const PROT = ['P', 'P'];
    const prot = panelRun([0, 1], new Set([0, 1]), false, PROT, new Set([0, 1]));
    if (prot.sidechainShowToggle.label.hidden !== false) {
        throw new Error('a protein selection has no Show switch');
    }
    if (prot.plateShowToggle.label.hidden !== true) {
        throw new Error('a protein is offered a Plate switch, and it has no plate');
    }
    // A NUCLEOTIDE KEEPS THE SWITCH TOO, with the menu beside it
    const nuc = panelRun([0, 1], new Set(), false, NUC);
    if (nuc.sidechainShowToggle.label.hidden !== false) {
        throw new Error('a nucleic selection lost its Show switch');
    }
    if (nuc.sidechainShowToggle.checked !== true) {
        throw new Error('a nucleotide drawn as a plate does not read as shown');
    }
    if (nuc.plateShowToggle.label.hidden !== false
        || nuc.plateShowToggle.checked !== true) {
        throw new Error('the Plate switch is missing or does not read on');
    }
    // ...AND THE MENU GOES WITH THE THING IT DESCRIBES. A way of drawing
    // something that is not drawn is a control for nothing.
    const off = panelRun([0, 1], new Set(), false, NUC, null, new Set(), null,
        null, new Set([0, 1]));
    if (off.sidechainShowToggle.checked !== false) {
        throw new Error('a hidden nucleotide reads as shown');
    }
    if (off.plateShowToggle.label.hidden !== true) {
        throw new Error('the Plate switch is offered for something not drawn');
    }
    // BOTH READ THE SAME ANSWER, worked out once from the object.
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/const mode = modes\.size === 1 \? \[\.\.\.modes\]\[0\] : '';/.test(app)) {
        throw new Error('the two controls no longer share one answer');
    }
    // ...and Show brings back the way it was last drawn rather than jumping to
    // the atoms, which is not a plain switch's decision to make
    if (!/setSelectionSidechainMode\(p2, v \? style : 'none'\)/.test(app)) {
        throw new Error('Show does not drive the style the menu names');
    }
    if (!/nuc \? \(\(plate && !plate\.checked\) \? 'full' : 'plate'\) : 'full'/.test(app)) {
        throw new Error('switching a nucleotide on no longer defaults to the plate');
    }
    // LEFT ALONE, NOT RESET. Clearing the Plate switch while nothing is drawn
    // loses the answer Show needs when it comes back: pick atoms, hide them,
    // show them again, and the plate returns instead.
    if (!/if \(mode === 'plate' \|\| mode === 'full'\) \{\s*\n\s*scSel\.checked = mode === 'plate';/.test(app)) {
        throw new Error('the Plate switch forgets its answer while it is hidden');
    }
});


t('a nucleotide is drawn as a plate or as its atoms, on one row', () => {
    // The plate had a row of its own, called "Side chain", next to the row
    // called "Side chains" that draws the real atoms - two controls for one
    // question, and no way to say "one or the other". Show answers whether;
    // Plate answers which, beside it, on the same row.
    const html = fs.readFileSync('index.html', 'utf8');
    if (html.indexOf('id="basesRow"') >= 0) throw new Error('the plate row is back');
    if (html.indexOf('id="plateShowToggle"') < 0) throw new Error('no Plate switch');
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/onToggle\('plateShowToggle', \(p2, v\) => \{/.test(app)
        || !/setSelectionSidechainMode\(p2, v \? 'plate' : 'full'\)/.test(app)) {
        throw new Error('the Plate switch is not wired');
    }
    // ...and it means what it says: plate on for the nucleotides, atoms off,
    // and the other way round for full
    const body = app.slice(app.indexOf('function setSelectionSidechainMode'),
        app.indexOf('function syncSelectionVisibility'));
    if (!/setBasesFor\(nuc, mode === 'plate'\)/.test(body)
        || !/setSelectionSidechains\(positions, mode === 'full'\)/.test(body)) {
        throw new Error('the three modes do not drive the two stores');
    }
    // the menu itself is offered only where the selection HAS nucleotides: a
    // protein side chain has one way of being drawn, so Show is the whole
    // question there
    const NUC = ['D', 'D'];
    const PROT = ['P', 'P'];
    if (panelRun([0, 1], new Set(), false, NUC).plateShowToggle.label.hidden !== false) {
        throw new Error('the Plate switch is hidden on a nucleic selection');
    }
    if (panelRun([0, 1], new Set([0, 1]), false, PROT, new Set([0, 1]))
        .plateShowToggle.label.hidden !== true) {
        throw new Error('a Plate switch is offered on a protein selection');
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

t('a ligand is banded along its bonds, not along the array', () => {
    // REPORTED ON 3PTB: a selected ligand showed bands between atoms that are
    // not bonded. A ligand atom is a position of the file's own, listed in the
    // order the file listed it, so index 223 is a calcium ion and 224 the first
    // carbon of a benzamidine 20 A away - neighbours in the array and joined by
    // nothing at all. Type 'L' is what says "this is an atom": these are not in
    // the side-chain map, which is what the rule used to test.
    const v = haloViewer([2, 3, 4, 5], 8);
    v.positionTypes = ['P', 'P', 'L', 'L', 'L', 'L', 'P', 'P'];
    v.sidechainMap = null;                            // no side chains anywhere
    v.bonds = [[3, 4], [4, 5]];                       // 2 is the lone ion
    const ctx = haloCtx();
    v._paintSelectionHalo(ctx);
    const got = haloEdges(ctx, v).filter(([a, b]) => a !== b && b >= 0)
        .map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)).sort();
    if (got.join(',') !== ['3-4', '4-5'].join(',')) {
        throw new Error('joined ' + JSON.stringify(got) + ', the bonds are '
            + '["3-4","4-5"] - consecutive ligand atoms are not connected');
    }
    // ...and the backbone either side of them still joins by index, which is
    // what a backbone IS
    const w = haloViewer([0, 1, 6, 7], 8);
    w.positionTypes = ['P', 'P', 'L', 'L', 'L', 'L', 'P', 'P'];
    w.sidechainMap = null; w.bonds = [];
    const ctx2 = haloCtx();
    w._paintSelectionHalo(ctx2);
    const back = haloEdges(ctx2, w).filter(([a, b]) => a !== b && b >= 0)
        .map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)).sort();
    if (back.join(',') !== ['0-1', '6-7'].join(',')) {
        throw new Error('the backbone stopped joining consecutive residues: '
            + JSON.stringify(back));
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
    for (const id of ['clipFar', 'clipNear', 'clipAutoButton']) {
        if (!panel.includes('id="' + id + '"')) {
            throw new Error('the clip panel has no ' + id);
        }
    }
    if (!/#clipRange input\[type=range\][^}]*position: absolute/.test(html)) {
        throw new Error('the two handles are not on one track');
    }
});

t('Auto fits the slab to the selection, and uncuts without one', () => {
    // A CUT IS WANTED AROUND SOMETHING. You pick a site and you want the rest
    // of the structure out of the way; doing that by hand means dragging two
    // knobs against a picture that changes as you drag, when the answer is
    // already known - the selection has a depth range in this view.
    const v = new Cls();
    const pos = [[0, 0, -30], [0, 0, 3], [0, 0, 5], [0, 0, 30]];
    v.coords = pos.map(([x, y, z]) => ({ x, y, z }));
    v.rotatedCoords = pos.map(([x, y, z]) => ({ x, y, z }));
    v._rotPending = false;
    v.lineWidth = 3;
    v.clipNear = 40; v.clipFar = -40;
    v.render = () => {};                  // setClipSlab repaints
    // the auto slab re-projects its centre every frame, so it needs a view
    v.viewerState = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], center: null };
    v.objectsData = {}; v.currentObjectName = 'o';
    v.residueSelection = new Set([1, 2]);
    const slab = v.clipSlabForSelection();
    // the pad is half the line width to clear the drawn radius, and the rest
    // is context - 3 A at the default width
    if (Math.abs(slab.near - 8) > 1e-6 || Math.abs(slab.far - 0) > 1e-6) {
        throw new Error(`the slab is ${slab.far}..${slab.near}, not the selection's`
            + ' 3..5 with room to breathe');
    }
    // the two positions at +/-30 are outside it, which is the point
    if (v.clipAccepts && (v.setClipSlab(slab.near, slab.far), v.clipAccepts(30))) {
        throw new Error('the far end of the structure survived the auto slab');
    }
    // ...AND WITH NOTHING SELECTED IT IS THE REST STATE, which is the answer
    // the Reset button used to give: no selection, no context, and the only
    // sensible context-free slab is all of it.
    v.residueSelection = null;
    const rest = v.clipSlabForSelection();
    const base = v.clipSlabDefault();
    if (!rest || !base || Math.abs(rest.near - base.near) > 1e-6
        || Math.abs(rest.far - base.far) > 1e-6) {
        throw new Error('Auto with no selection is not the rest state, so'
            + ' replacing Reset with it took away the only way to uncut');
    }
    // ...and it asks the MASK, the same as Orient does: a hidden atom is not
    // part of what the view is being cut around. Hide the one at z = 5 and the
    // slab closes onto the one at z = 3.
    v.residueSelection = new Set([1, 2]);
    v.visiblePositions = new Set([0, 1, 3]);
    const half = v.clipSlabForSelection();
    if (Math.abs(half.near - 6) > 1e-6 || Math.abs(half.far - 0) > 1e-6) {
        throw new Error(`hiding half the selection left the slab at ${half.far}`
            + `..${half.near}, not closed onto what is still drawn`);
    }
    // THE THICKNESS IS THE SELECTION'S RADIUS, NOT ITS DEPTH IN THIS VIEW,
    // because the user is going to rotate. A site lying flat in the screen
    // plane has almost no depth: cut to that and a quarter turn stands it on
    // end and slices it in half. These two are 20 A apart ACROSS the screen
    // and at the same depth, so a depth-range slab would be 6 A thick (the pad
    // alone) and this one is 26.
    const flat = new Cls();
    const across = [[-10, 0, 0], [10, 0, 0], [0, 0, 25]];
    flat.coords = across.map(([x, y, z]) => ({ x, y, z }));
    flat.rotatedCoords = across.map(([x, y, z]) => ({ x, y, z }));
    flat._rotPending = false;
    flat.lineWidth = 3;
    flat.clipNear = 40; flat.clipFar = -40;
    flat.render = () => {};
    flat.viewerState = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], center: null };
    flat.objectsData = {}; flat.currentObjectName = 'o';
    flat.residueSelection = new Set([0, 1]);
    const wide = flat.clipSlabForSelection();
    if (Math.abs((wide.near - wide.far) - 26) > 1e-6) {
        throw new Error(`a selection 20 A wide and flat to the screen got a slab`
            + ` ${(wide.near - wide.far).toFixed(1)} A thick - it will be cut in`
            + ' half the moment the model turns');
    }
    // AND IT STAYS ON THE SELECTION THROUGH A ROTATION. A slab is camera space
    // and the site it was cut around is not, so turning the model moved one
    // and not the other: the cut slid off, and pressing Auto again gave a
    // different pair of planes at every angle because the depth of the thing
    // had changed underneath it.
    const spin = new Cls();
    const pts = [[0, 0, 0], [12, 0, 0]];       // the second is off to the side
    spin.coords = pts.map(([x, y, z]) => ({ x, y, z }));
    spin.rotatedCoords = pts.map(([x, y, z]) => ({ x, y, z }));
    spin._rotPending = false;
    spin.lineWidth = 3;
    spin.render = () => {};
    spin.objectsData = {}; spin.currentObjectName = 'o';
    spin.viewerState = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], center: null };
    spin.residueSelection = new Set([1]);
    const first = spin.autoClip();
    // face on, the selected point is at z = 0, so the slab straddles zero
    if (Math.abs((first.near + first.far) / 2) > 1e-6) {
        throw new Error('the slab is not centred on the selection');
    }
    // ...now turn a quarter turn about y: the point swings to z = -12
    spin.viewerState.rotation = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
    spin._refreshAutoClip();
    if (Math.abs((spin.clipNear + spin.clipFar) / 2 + 12) > 1e-6) {
        throw new Error('after a quarter turn the slab sits at '
            + ((spin.clipNear + spin.clipFar) / 2).toFixed(1) + ', not on the'
            + ' selection at -12 - the cut has slid off the thing it was for');
    }
    // ...and the thickness never changed, because a radius does not rotate
    if (Math.abs((spin.clipNear - spin.clipFar) - (first.near - first.far)) > 1e-6) {
        throw new Error('the slab changed thickness on a rotation');
    }
    // A KNOB DRAGGED WINS. Any explicit set drops the tracking, or the next
    // frame would overwrite the answer the user just gave.
    spin.setClipSlab(5, -5);
    spin.viewerState.rotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    spin._refreshAutoClip();
    if (spin.clipNear !== 5 || spin.clipFar !== -5) {
        throw new Error('a hand-set slab was overwritten by the auto tracking');
    }
    // ...though a selection that is ENTIRELY hidden frames on itself anyway -
    // framingPositions' own guard, shared with Orient, and the alternative is
    // an Auto that silently uncuts because of something you hid earlier.
    v.visiblePositions = new Set([0, 3]);
    const allHidden = v.clipSlabForSelection();
    if (Math.abs(allHidden.near - 8) > 1e-6) {
        throw new Error('a fully hidden selection no longer frames on itself');
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

t('the nucleic trace is smoothed, and everything nucleic reads the same trace', () => {
    // A C4' TRACE IS NOT A CURVE. The atom sits one bond out from the base and
    // the sugar pucker swings it about the glycosidic axis, so everything the
    // drawing infers from the local screw inherits the wobble. Measured on
    // 1BNA, the angle between consecutive predicted base normals - about 12
    // degrees on real stacked bases:
    //
    //     raw C4'             46.2 +/- 55.2   (the spread IS the wave)
    //     smoothed (this)     12.0 +/-  5.5
    //     a C1' trace         28.4 +/- 16.7
    //     a P trace           worst of the three off an ideal helix
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    if (!/function smoothNucleicTrace\(/.test(cart)) {
        throw new Error('the nucleic trace is drawn raw again');
    }
    // TAUBIN, NOT A PLAIN AVERAGE: averaging shrinks a curve - two Laplacian
    // passes pulled a duplex in 6% and moved every point 1.18 A, which cost a
    // tenth of the ribbon's ink and rounded off a tRNA's turns.
    const steps = cart.match(/const NA_SMOOTH_STEPS = \[([^\]]+)\]/);
    if (!steps) throw new Error('no smoothing schedule');
    const seq = steps[1].split(',').map((x) => Number(x.trim()));
    if (!(seq.length >= 2 && seq.some((x) => x > 0) && seq.some((x) => x < 0))) {
        throw new Error('the schedule is not a shrink-then-unshrink pair: ' + steps[1]);
    }
    if (Math.abs(seq.reduce((a, b) => a + b, 0)) > 0.2) {
        throw new Error('the passes do not cancel, so the trace shrinks');
    }
    // ONE ARRAY FOR EVERYTHING NUCLEIC, or the plates are left behind by their
    // own rail - which is why the strand-flattening pass is protein-only.
    for (const use of ['const baseFramesRot = hasNA \\? predictBaseFrames\\(\\s*\\n\\s*\\(i\\) => naPos\\[i\\]',
        'let basePos = naPos;', 'const atRaw = \\(i\\) => naPos\\[i\\];',
        'const u = naPos\\[k\\], v = naPos\\[q\\];']) {
        if (!new RegExp(use).test(cart)) {
            throw new Error('something nucleic still reads the raw trace: ' + use);
        }
    }
    // ...and the base ATOMS ride along, or the sugar detaches from the ribbon
    // by the distance the trace moved
    if (!/out\[idx\] = \{ x: p\.x \+ \(d\.x - r\.x\)/.test(cart)) {
        throw new Error('appended base atoms do not follow their trace');
    }
    // ...and it is switchable, for the next person comparing
    if (!/renderer\.naSmooth !== false/.test(cart)) {
        throw new Error('there is no way to turn the smoothing off');
    }
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    if (!/naSmooth === false \? 'naraw' : 'nasmooth'/.test(gpu)) {
        throw new Error('the GPU mesh signature ignores the smoothing, so'
            + ' switching it would repaint a mesh built the other way');
    }
});

t('the selection band holds its proportion at every size', () => {
    // THE BAND STOPPED TRACKING WHATEVER GOT BIG ON SCREEN. Its margin is
    // proportional - 1.3 x the drawn radius, which is what makes a highlight
    // look the same at every zoom - but the ceiling on it was a flat 14 px. A
    // ribbon is 2-7 px and never reached it, so the rule looked right; zoom in,
    // or mark a metal (27 px at zoom 4 against a helix's 7), and the margin is
    // held at 14 while the thing keeps growing, so the band tightens onto it.
    // Reported as the highlight not tracking the zoom. It was not the zoom, it
    // was the size on screen - which is exactly what a flat pixel clamp cannot
    // follow, at either end.
    // the shipped rule itself, lifted with the rest of the module (see the top)
    const bandFor = global.selectionBandFor;
    // ...the proportion it exists to hold. 2.3 = 1 + the 1.3 gain, as a radius.
    for (const rad of [2, 3.5, 5.4, 7, 10, 13]) {
        const ratio = bandFor(rad, 1) / 2 / rad;
        if (Math.abs(ratio - 2.3) > 0.02) {
            throw new Error(`a mark of ${rad} px gets a band ${ratio.toFixed(2)}x its`
                + ' radius, not the 2.3x the gain asks for');
        }
    }
    // ...at EVERY size, including the big ones. There is no ceiling: a band
    // around a big thing is big, and a bound on it is the point where the
    // highlight stops following what it marks.
    for (const rad of [20, 27, 50, 200]) {
        const ratio = bandFor(rad, 1) / 2 / rad;
        if (Math.abs(ratio - 2.3) > 0.02) {
            throw new Error(`a mark of ${rad} px gets ${ratio.toFixed(2)}x its radius`
                + ' - something is bounding the band again, and that is where it'
                + ' stops tracking');
        }
    }
    // ...AND WHERE THE THING HAS A SIZE OF ITS OWN, the margin comes from the
    // VIEW rather than from the thing. A zinc's ball is 6.89 px where an
    // ordinary residue measures 1.86, so a margin taken from the ball's own
    // radius put a ring around the metal three and a half times the ring
    // around the chain beside it - reported as the highlight starting out too
    // large and then not keeping pace. The ring is a pen: same width on
    // everything, and it follows the zoom because the residue radius does.
    for (const rad of [5, 10, 27]) {
        const margin = bandFor(rad, 1, 1.86) / 2 - rad;
        if (Math.abs(margin - 1.3 * 1.86) > 0.01) {
            throw new Error(`a mark of ${rad} px sticks out by ${margin.toFixed(2)} px,`
                + ' not the 2.42 the view asks for - the margin is being taken'
                + ' from the mark again');
        }
    }
    // ...and a SMALL one is not given a band out of proportion either: the
    // floor is on the whole band, not added to the margin, so it binds only
    // where the mark is genuinely sub-pixel. A 1.7 px zinc used to get 4.2 px
    // (2.5x) and now gets 3.9 (2.3x).
    const small = bandFor(1.7, 1) / 2 / 1.7;
    if (Math.abs(small - 2.3) > 0.02) {
        throw new Error(`a 1.7 px mark gets ${small.toFixed(2)}x its radius`);
    }
    // ...and the floor still marks a hairline
    if (bandFor(0.4, 1) / 2 < 2.5) throw new Error('a hairline gets no band at all');
});

t('every projection sizes a position through the same rule', () => {
    // FOUR PROJECTIONS fill screenRadius - the 2D pass at the end of its
    // render, the GPU's projectPositions, _projectForPicking, and the older
    // per-position projectPosition - and each used to size a position itself.
    // They agreed for as long as everything was a segment of something. A lone
    // atom is not: it is drawn as a ball of its element's van der Waals radius,
    // and the selection band over a zinc came out of the width of a BOND,
    // sitting inside the metal it was marking. Two of the four were fixed
    // before anyone noticed the other two were writing the same array.
    const files = ['py2Dmol/resources/viewer-mol.js',
        'py2Dmol/resources/viewer-cartoon.js',
        'py2Dmol/resources/viewer-cartoon-gpu.js'];
    let writes = 0;
    for (const f of files) {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!/screenRadius\[[^\]]+\]\s*=/.test(lines[i])) continue;
            writes++;
            const near = lines.slice(Math.max(0, i - 8), i + 3).join('\n');
            if (!near.includes('_positionRadiiPx')) {
                throw new Error(`${f}:${i + 1} sizes a position without the shared`
                    + ' rule - a fifth copy of it, and the one that will be wrong'
                    + ' about whatever is drawn at a size it does not know');
            }
        }
    }
    if (writes < 3) throw new Error('found only ' + writes + ' projections - regex stale');
    // ...and the rule itself: exact for a lone atom, the old estimate otherwise
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('_positionRadiiPx(i, base, wm, pe, scale) {');
    if (at < 0) throw new Error('no shared rule to share');
    const body = mol.slice(at, mol.indexOf('\n        }', at));
    if (!/loneAtomRadiusA/.test(body) || !/SELECTION_HALO_RADIUS_FRAC/.test(body)) {
        throw new Error('the rule no longer covers both kinds of position');
    }
    // the band measures off the DRAWN radius, and nothing else
    if (!/screenDrawRadius/.test(mol.slice(mol.indexOf('_paintSelectionHalo')))) {
        throw new Error('the selection band is back to guessing from the click target');
    }
});

t('the header is the title alone, and the page buttons keep quiet', () => {
    // The title and a strapline were two stacked blocks with their own margins
    // - 73 px of page for a word and a sentence, above a panel that is three
    // lines itself. The line said "Upload a PDB/CIF file, or fetch by PDB or
    // UniProt ID", which describes the two controls directly beneath it: a box
    // whose placeholder is an ID, and a button that says Upload.
    const html = fs.readFileSync('index.html', 'utf8');
    const head = html.indexOf('class="page-head"');
    if (head < 0) throw new Error('the header block is gone');
    const block = html.slice(head, html.indexOf('id="upload-options-container"'));
    if (!/<h1>/.test(block)) throw new Error('the header lost its title');
    if (/<p>/.test(block)) {
        throw new Error('the strapline is back - it describes the two controls'
            + ' directly under it');
    }
    const css = fs.readFileSync('web/style.css', 'utf8');
    const rule = css.slice(css.indexOf('.page-head {'), css.indexOf('.page-head h1'));
    // SAVE, CLEAR ALL AND GPU ARE POSITIONED ABSOLUTELY against the same
    // container, so nothing pushes the header out of their way: a title long
    // enough would run underneath them. The padding is what reserves the
    // space, and it is the kind of thing a later tidy-up removes as unused.
    if (!/padding-right:\s*\d+px/.test(rule)) {
        throw new Error('the header reserves no room for the button cluster'
            + ' pinned to its top right');
    }
    // ...AND THOSE THREE ARE SMALLER AND QUIETER THAN THE PANEL'S. They stand
    // there for the whole session while Fetch and Upload are used once, so at
    // equal weight the standing three take the eye first - and the first thing
    // to do on this page is load something. Measured: 28 px at 12 px type and
    // 0.72 opacity, against 36 px at 14 px and full.
    if (!/class="page-actions"/.test(html)) {
        throw new Error('the page-level buttons are no longer marked as such');
    }
    const act = css.slice(css.indexOf('.page-actions .btn,'));
    const size = act.slice(0, 600);
    if (!/--btn-height-small/.test(size)) {
        throw new Error('the page buttons are full height again');
    }
    // OUTLINED, NOT FADED. Fading was the first attempt and it was the wrong
    // instrument: a faded red is a red that looks broken. White ground,
    // coloured letters, coloured border - a lighter weight rather than a
    // weaker version of the same thing.
    if (!/border:\s*1px solid currentColor/.test(size)
        || !/background:\s*#fff/.test(size)) {
        throw new Error('the page buttons are filled again rather than outlined');
    }
    if (/opacity:\s*0\.\d/.test(act.slice(0, 900))) {
        throw new Error('the page buttons are faded again - a faded red reads'
            + ' as a broken button, not as a quiet one');
    }
    // ONE RULE FOR ALL THREE, because their skins are different elements: two
    // buttons and a label wrapping a checkbox. Listed apart, they drift - the
    // label kept its own height and sat 4 px above its neighbours.
    if (!/\.page-actions \.btn-toggle-global \{[^}]*--btn-height-small/.test(css)) {
        throw new Error('the GPU label is not held to the same height as the'
            + ' two buttons beside it, so it will not sit on their line');
    }
    for (const id of ['#saveStateButton', '#clearAllButton']) {
        if (!new RegExp('\\.page-actions ' + id + ' \\{ color:').test(css)) {
            throw new Error(id + ' has no colour of its own, so the outline'
                + ' stops saying which button it is');
        }
    }
    // ...and the load button says what it does. "Files" named the things
    // rather than the action, beside a Fetch that names an action.
    if (!/id="upload-button"[\s\S]{0,200}<span>Upload<\/span>/.test(html)) {
        throw new Error('the upload button does not say Upload');
    }
});

t('the fetch panel folds its options away, in groups', () => {
    // It was a two-column table: an ID box on the left, seven switches
    // standing open on the right, and the examples squeezed into half a column
    // where the fourth wrapped onto a second row. The options are DEFAULTS -
    // almost nobody changes them - so the layout was sized by its least used
    // part. Measured: the panel was 189 px tall and is 78 with the options
    // folded, and the four examples went from two rows to one.
    const html = fs.readFileSync('index.html', 'utf8');
    const at = html.indexOf('class="fetch-panel"');
    if (at < 0) throw new Error('the fetch panel is gone');
    const panel = html.slice(at, html.indexOf('id="status-message"'));
    // EVERY CONTROL SURVIVED THE MOVE. Losing one to a rewrite is silent: the
    // option simply stops being settable and the default stands for ever.
    for (const id of ['fetch-id', 'fetch-btn', 'upload-button', 'file-upload',
        'loadAsFramesCheckbox', 'alignFramesCheckbox', 'alignChainInput',
        'loadPAECheckbox', 'loadMSACheckbox', 'biounitCheckbox',
        'loadLigandsCheckbox', 'filterAdditivesCheckbox']) {
        if (!panel.includes('id="' + id + '"')) {
            throw new Error('the redesign dropped ' + id);
        }
    }
    // ...folded away, and the button says so to a screen reader as well as in
    // its caret
    const opts = panel.indexOf('id="fetchOptions"');
    if (opts < 0 || !/id="fetchOptions"[^>]*hidden/.test(panel)) {
        throw new Error('the options are not hidden to start with');
    }
    if (!/id="fetchOptionsButton"[\s\S]{0,200}aria-controls="fetchOptions"/.test(panel)) {
        throw new Error('the Options button does not name what it opens');
    }
    const css = fs.readFileSync('web/style.css', 'utf8');
    if (!/\.fetch-options\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css)) {
        throw new Error('[hidden] is a UA rule and display:flex outranks it -'
            + ' the options would stand open however the flag is set');
    }
    // THE EXAMPLES ARE A SET AND READ AS ONE ON ONE LINE, which is what giving
    // the row the whole width was for. nowrap keeps it that way when a fifth
    // is added - deliberately, so that becomes a decision about width.
    if (!/\.fetch-examples\s*\{[^}]*flex-wrap:\s*nowrap/.test(css)) {
        throw new Error('the examples row can wrap again');
    }
    // ...AND THE OPTIONS ARE GROUPED BY WHAT THEY ASK. Which question a switch
    // belongs to is not obvious from its name: Align chain is about frames,
    // Filter Additives is about what the file contains.
    const groups = (panel.match(/class="fetch-option-group"/g) || []).length;
    if (groups < 3) throw new Error('the options are one flat list again');
    for (const [title, first] of [['Frames', 'loadAsFramesCheckbox'],
        ['Structure', 'biounitCheckbox'], ['Alongside', 'loadPAECheckbox']]) {
        const g = panel.indexOf('>' + title + '<');
        if (g < 0) throw new Error('no ' + title + ' group');
        const next = panel.indexOf('class="fetch-option-group"', g);
        const body = panel.slice(g, next < 0 ? panel.length : next);
        if (!body.includes(first)) {
            throw new Error(`${first} is not in the ${title} group`);
        }
    }
});

t('what the crystal was grown in is filtered, and the two lists agree', () => {
    // A BUFFER SALT IS A REAL RESIDUE AND NOT PART OF THE MOLECULE. Dropped at
    // the atom list, before anything downstream sees it, so a sulfate does not
    // arrive with the same weight as the one ligand that matters.
    const sandbox = { window: {}, console, document: {} };
    sandbox.window.window = sandbox.window;
    require('vm').createContext(sandbox);
    require('vm').runInContext(fs.readFileSync('web/utils.js', 'utf8'), sandbox,
        { filename: 'utils' });
    const js = sandbox.window.CRYSTAL_ADDITIVES;
    if (!js || !js.size) throw new Error('web/utils.js exports no additive list');
    // the obvious ones go...
    for (const code of ['SO4', 'GOL', 'EDO', 'MPD', 'TRS', 'ACT', 'DMS', 'NA', 'CL']) {
        if (!js.has(code)) throw new Error(code + ' is not filtered');
    }
    // ...AND THE BORDERLINE ONES STAY, which is the part worth pinning. Each of
    // these is on somebody's additive list and each is sometimes the point:
    // phosphate is half of biochemistry, bicarbonate is a photosystem II
    // cofactor, spermine is real DNA chemistry, a detergent in a porin sits
    // where the membrane lipid would, and a metal is structural far more often
    // than not. Hiding a real cofactor is worse than showing a sulfate.
    for (const code of ['PO4', 'BCT', 'SPM', 'C8E', 'ZN', 'MG', 'MN', 'FE', 'CA',
        'HEM', 'HEC', 'NAG', 'ATP', 'ADP', 'GTP', 'NAD', 'FAD', 'SAM']) {
        if (js.has(code)) {
            throw new Error(code + ' is being filtered out as an additive - it is'
                + ' the kind of thing people open a structure to look at');
        }
    }
    // THE PYTHON COPY MUST MATCH. A structure opened in the notebook and the
    // same one dropped on the web page cannot disagree about what is in it.
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    const at = py.indexOf('CRYSTAL_ADDITIVES = {');
    if (at < 0) throw new Error('py2Dmol/viewer.py has no additive list');
    const block = py.slice(at, py.indexOf('\n}', at));
    const pyCodes = new Set((block.match(/'([A-Z0-9]{1,3})'/g) || [])
        .map((q) => q.slice(1, -1)));
    for (const code of js) {
        if (!pyCodes.has(code)) throw new Error('viewer.py is missing ' + code);
    }
    for (const code of pyCodes) {
        if (!js.has(code)) throw new Error('web/utils.js is missing ' + code);
    }
    // ...and the filter runs on the atom list, behind a switch
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/maybeFilterLigands\(maybeFilterAdditives\(/.test(app)) {
        throw new Error('the additive filter is not in the load path');
    }
    if (!/filterAdditives === false\) return atoms/.test(app)) {
        throw new Error('there is no way to switch the filter off, and a list of'
            + ' codes is a judgement that has to be escapable');
    }

    // A METAL IS JUDGED BY HOW MANY OF IT THERE ARE. One magnesium is an
    // active site and 4UG0's 239 are the mortar a ribosome is built with, so
    // the same code is kept in one structure and dropped in another. Run the
    // shipped function over both cases rather than reading it.
    const at2 = app.indexOf('function maybeFilterAdditives(');
    let d2 = 0; let k2 = app.indexOf('{', at2);
    for (; k2 < app.length; k2++) {
        if (app[k2] === '{') d2++; else if (app[k2] === '}' && !--d2) break;
    }
    // eslint-disable-next-line no-new-func
    const f2 = new Function('window',
        app.slice(at2, k2 + 1) + '; return maybeFilterAdditives;')(
        { viewerConfig: { ui: {} }, CRYSTAL_ADDITIVES: js,
            CROWD_ION_COUNT: sandbox.window.CROWD_ION_COUNT });
    const ion = (code, seq) => ({ record: 'HETATM', resName: code, chain: 'A',
        resSeq: seq, x: 0, y: 0, z: 0 });
    const ribosome = [];
    for (let i = 0; i < 239; i++) ribosome.push(ion('MG', i));
    for (let i = 0; i < 6; i++) ribosome.push(ion('ZN', 1000 + i));
    const left = f2(ribosome);
    if (left.some((a) => a.resName === 'MG')) {
        throw new Error('239 magnesiums came through - a ribosome opens as a'
            + ' cloud of ions with the structure somewhere behind them');
    }
    if (left.filter((a) => a.resName === 'ZN').length !== 6) {
        throw new Error('the six zincs went with them');
    }
    // ...while a handful of the SAME code stays: 9FOG's 4 magnesiums are sites
    const site = [ion('MG', 1), ion('MG', 2), ion('MG', 3), ion('MG', 4)];
    if (f2(site).length !== 4) {
        throw new Error('four magnesiums are an active site, not scenery');
    }
    // ...and a crowd of something with real atoms in it is the subject, not
    // scenery: a photosystem has 60 chlorophylls of 65 atoms each
    const chlorophylls = [];
    for (let i = 0; i < 60; i++) {
        for (let j = 0; j < 65; j++) {
            chlorophylls.push(Object.assign(ion('CLA', i), { atomName: 'C' + j }));
        }
    }
    if (f2(chlorophylls).length !== chlorophylls.length) {
        throw new Error('the chlorophylls were filtered as a crowd of ions');
    }
    // ...and the threshold is the same number on both sides
    const pyCrowd = /CROWD_ION_COUNT = (\d+)/.exec(py);
    if (!pyCrowd || +pyCrowd[1] !== sandbox.window.CROWD_ION_COUNT) {
        throw new Error('the crowd threshold differs between the two parsers');
    }
});

t('a metal has a colour and a size of its own', () => {
    // A LONE ION USED TO TAKE WHATEVER THE LIGAND PALETTE HANDED IT - a zinc
    // came out orange in one chain and green in the next - and was drawn at
    // 0.6 A whatever it was, the 'L' segment baseline, thinner than the bonds
    // around it. Both are element facts and both now come from a table.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('static get ELEMENT_COLORS()');
    if (at < 0) throw new Error('no element colour table');
    const tbl = mol.slice(at, mol.indexOf('\n        }', at));
    // PyMOL's own values (layer1/Color.cpp, floats x 255), so the drawing
    // agrees with the viewer everyone reads structures in
    for (const [el, rgb] of [['ZN', [125, 128, 176]], ['FE', [224, 102, 51]],
        ['MG', [138, 255, 0]], ['CA', [61, 255, 0]], ['NA', [171, 92, 242]],
        ['MN', [156, 122, 199]], ['CU', [200, 128, 51]]]) {
        const m = new RegExp(el + ':\\s*\\{\\s*r:\\s*(\\d+),\\s*g:\\s*(\\d+),\\s*b:\\s*(\\d+)').exec(tbl);
        if (!m) throw new Error(`${el} has no colour, so it falls back to whatever`
            + ' colour its position had - which says nothing about what it is');
        const got = [+m[1], +m[2], +m[3]];
        if (got.join() !== rgb.join()) {
            throw new Error(`${el} is ${got} and PyMOL's is ${rgb}`);
        }
    }
    // CARBON MUST STAY OUT: a null sends the atom to its residue's colour, so a
    // coloured side chain keeps its colour with only heteroatoms standing out.
    if (/\n\s*C:\s*\{/.test(tbl)) {
        throw new Error('carbon has an element colour, so every ligand is now grey');
    }
    // ...and the size, shared with viewer-mol.js so the click target and the
    // selection band are the circle that is actually drawn
    const sandbox = {
        window: { addEventListener() {}, dispatchEvent() {} },
        document: { createElement: () => ({ getContext: () => null }) },
        console, performance: { now: () => Date.now() }, Event: function () {},
    };
    sandbox.window.window = sandbox.window;
    require('vm').createContext(sandbox);
    require('vm').runInContext(
        fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8'),
        sandbox, { filename: 'cartoon' });
    const rad = sandbox.window.py2dmolCartoon.loneAtomRadiusA;
    if (!rad) throw new Error('loneAtomRadiusA is not exported, so viewer-mol.js'
        + ' cannot size a click target from the same number that drew the ball');
    // van der Waals, so ZINC IS SMALLER THAN CARBON (1.39 against 1.70). It
    // reads as wrong and it is right; anyone "fixing" it should fail here.
    if (!(rad('ZN') < rad('C'))) throw new Error('these are not vdW radii');
    if (!(rad('K') > rad('NA') && rad('NA') > rad('ZN'))) {
        throw new Error('the element order is wrong: K > Na > Zn by vdW radius');
    }
    if (rad('XX') !== rad('C')) throw new Error('an unknown element should take carbon\'s');
    if (!mol.includes('loneAtomRadiusA')) {
        throw new Error('viewer-mol.js sizes lone atoms from something else again');
    }
});

t('the tube follows the view centre, so Orient goes where it says', () => {
    // ORIENT MOVES THE VIEW CENTRE onto the selection. The tube's instance data
    // is model space with the COORDINATE MEAN subtracted and is deliberately
    // view-independent - turning the model does not change a byte of it - so a
    // centre that moves has to reach the shader as a uniform. It did not: the
    // faces and the ink programs both had uShift and the tube program had no
    // such thing, so it went on drawing about the mean. Measured on 1UBQ,
    // orienting on residue 9 put the 2D drawing's ink centroid at (217, 434)
    // and left the GPU's at (299, 278) - the whole structure still sitting in
    // the middle of the canvas, which is what "Orient moves it somewhere else"
    // looks like from the outside.
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const at = gpu.indexOf('const VSTUBE');
    const vs = gpu.slice(at, gpu.indexOf('`;', at));
    if (!/uniform vec3 uShift/.test(vs)) {
        throw new Error('the tube shader takes no view shift, so Orient cannot move it');
    }
    // BOTH ENDS. One of the two carrying it would shear every segment.
    if (!/uRot \* \(aP0 \+ uShift\)/.test(vs) || !/uRot \* \(aP1 \+ uShift\)/.test(vs)) {
        throw new Error('the shift is not applied to both ends of the capsule');
    }
    // ...and the draw fills it from the live framing against the centre the
    // instances were built about
    if (!/uniform3f\(gl\.getUniformLocation\(progTube, 'uShift'\)/.test(gpu)) {
        throw new Error('nothing sets the tube shift at draw time');
    }
    if (!/tubeCentre\[0\] - fr\.centre\[0\]/.test(gpu)) {
        throw new Error('the shift is not the move since the instances were built');
    }
    // THE DEPTH RANGE TRAVELS WITH IT, or the slab and the depth mapping are
    // measured about a centre the geometry has left.
    if (!/tubeRange\[0\] \+ dzTube/.test(gpu)) {
        throw new Error('the tube depth range does not follow the shift');
    }
});

t('one segment owns the ball at a joint, and both paint it', () => {
    // TWO TUBES MEETING AT AN ATOM overlap in a lens, and a depth buffer picks
    // between their surfaces per pixel. The surfaces cross right there, so the
    // pick flips inside the lens and the seam between two differently coloured
    // segments is a hard diagonal - on a three-atom chain, two bonds that
    // appear to cross in the middle.
    //
    // ARBITRATING IT BY DEPTH DOES NOT WORK, and this test exists because it
    // was tried twice. Cutting the unowned side out exposed the joint cap's
    // rim, which is hidden precisely BY both fills being there (see uCapZ);
    // pushing the unowned side back needs to know which end's ball a fragment
    // is in, and a segment pointing at the camera projects both of its ends
    // into the same disc, so the diagonal came back at those angles.
    //
    // Nothing needs to win: both segments paint the ball in the OWNER's
    // colour, decided on the CPU, so the depth buffer's choice stops being
    // visible. The geometry is untouched.
    const gpu = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const at = gpu.indexOf('const FSTUBE');
    const fsrc = gpu.slice(at, gpu.indexOf('`;', at));
    if (!/col = vJColA/.test(fsrc) || !/col = vJColB/.test(fsrc)) {
        throw new Error('the ball at a joint no longer takes the owner colour');
    }
    // THE FILL MUST NOT TOUCH DEPTH. Every depth trick tried here broke
    // something else; the whole point of the colour is that it does not.
    const fill = fsrc.slice(fsrc.indexOf('bool skirt ='));
    const zTweak = /zSurf\s*[-+]=/.exec(fill);
    if (zTweak) {
        throw new Error('the joint is being settled by depth again (' + zTweak[0]
            + ') - that is what exposed the cap rim and failed end-on');
    }
    // ...and the colour is carried per instance, one per end
    if (!/in vec2 aJCol/.test(gpu) || !/bind\('aJCol', 2, 52\)/.test(gpu)) {
        throw new Error('the ball colour is not on the instance any more');
    }
    // ...patched to the OWNER's after every segment's colour is known: the
    // owner may be a segment the emit has not reached, and its colour is not
    // its palette entry - the occlusion tint is per segment.
    if (!/data\[at \+ 13\] = colOf\[ownA\]/.test(gpu)
        || !/data\[at \+ 14\] = colOf\[ownB\]/.test(gpu)) {
        throw new Error('the two segments at a joint are not given one colour');
    }
    // ...AND THE OWNER IS THE OUTGOING SEGMENT. The 2D pass paints along the
    // chain and the later segment's cap covers the earlier one, so the ball
    // that shows belongs to the segment STARTING there.
    if (/jointCaps && claim\[/.test(gpu)) {
        throw new Error('the claim is gated on jointCaps, so with caps off no'
            + ' segment owns a joint');
    }
    const first = gpu.indexOf('if (touch[sg2.idx1] > 1 && claim[sg2.idx1] === 0)');
    const second = gpu.indexOf('if (touch[sg2.idx2] > 1 && claim[sg2.idx2] === 0)');
    if (first < 0 || second < 0 || !(first < second)) {
        throw new Error('the outgoing segment no longer claims a joint first,'
            + ' so the ball shows the wrong side of it');
    }
});

t('a lone atom reaches the GPU, as a disc', () => {
    // METALS WENT MISSING IN GPU MODE. A lone atom - an ion, most often - is a
    // zero-length segment, drawn by the 2D pass as a shaded circle. The GPU
    // translator had no branch for it, so it fell through to the skip list and
    // every ion in the structure was absent from the frame: measured on 1EHZ,
    // {dot: 9}, six magnesiums and three manganeses; on 1TF6, all six zincs.
    const sandbox = {
        window: { addEventListener() {}, dispatchEvent() {} },
        document: { createElement: () => ({ getContext: () => null }) },
        console, performance: { now: () => Date.now() }, Event: function () {},
    };
    sandbox.window.window = sandbox.window;
    require('vm').createContext(sandbox);
    require('vm').runInContext(
        fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8'),
        sandbox, { filename: 'gpu' });
    const G = sandbox.window.py2dmolCartoonGPU;
    if (!G || !G.facesOf) throw new Error('the GPU module did not load');
    const R = 12;
    const out = G.facesOf([{ kind: 'dot', pA: [100, 120, 5, 1], x1: 100, y1: 120,
        z: 5, r: R, rA: 1.39, c: { r: 1, g: 2, b: 3 }, ci: 4, gs0: 7 }], undefined);
    if (out.skipped) throw new Error('the GPU still skips a lone atom');
    if (out.faces.length !== 1) {
        throw new Error(`a lone atom should be ONE quad, got ${out.faces.length}`
            + ' - a tessellated ball is the wrong drawing and ~50x the faces');
    }
    const f = out.faces[0];
    // the shader billboards it and solves the circle, so it must be told to do
    // both: shade it as a ball (unlit = do not shade it as a quad), and keep
    // the square's own edges out of the outline
    for (const k of ['disc', 'unlit', 'noInk']) {
        if (!f[k]) throw new Error(`the disc face is missing ${k}`);
    }
    // THE SQUARE CARRIES THE RADIUS AS ITS HALF-DIAGONAL, which is the only
    // thing the vertex shader reads off it. Getting this wrong scales every
    // ion in the picture and nothing says so.
    const ctr = [0, 1, 2].map((j) => f.q.reduce((a, q) => a + q[j], 0) / 4);
    const half = Math.hypot(f.q[0][0] - ctr[0], f.q[0][1] - ctr[1]) * Math.SQRT1_2;
    if (Math.abs(half - R) > 1e-6) {
        throw new Error(`the disc quad's half-diagonal is ${half}, not the radius ${R}`);
    }
});

t('every varying the shared fragment shader reads is written by BOTH vertex shaders', () => {
    // ONE FRAGMENT SHADER, TWO PROGRAMS. FS is linked against the flat VS and
    // against VS3D, and a varying it reads that one of them does not write is
    // not a warning - it fails the LINK. Both programs are built inside one try
    // block, so the whole GPU path then falls back to the 2D one with a single
    // console line, and the picture still looks almost right: it took a run
    // where GPU and 2D came back pixel-identical to notice.
    const src = fs.readFileSync('py2Dmol/resources/viewer-cartoon-gpu.js', 'utf8');
    const lit = (name) => {
        const at = src.indexOf('const ' + name + ' = `');
        if (at < 0) throw new Error('no shader called ' + name);
        const from = src.indexOf('`', at) + 1;
        return src.slice(from, src.indexOf('`;', from));
    };
    const fsSrc = lit('FS'); const vs = lit('VS'); const vs3d = lit('VS3D');
    const want = [...fsSrc.matchAll(/\bin\s+(float|vec2|vec3|vec4)\s+(v\w+)/g)];
    if (want.length < 3) throw new Error('found no varyings to check - regex stale');
    for (const [, type, name] of want) {
        for (const [tag, body] of [['VS', vs], ['VS3D', vs3d]]) {
            if (!new RegExp('\\bout\\s+' + type + '\\s+' + name + '\\b').test(body)) {
                throw new Error(`FS reads ${type} ${name} and ${tag} never declares it`
                    + ' - the program will not link and the GPU path dies silently');
            }
        }
    }
});

t('a cut duplex is smoothed exactly as the uncut one was', () => {
    // THE ENDS. Build an ideal B-DNA C4' helix, smooth it, then CUT it in the
    // middle and smooth the piece: every surviving residue must move where it
    // moved before. It is the one case with a known answer, and it catches the
    // failure that pinning the ends looks innocent enough to hide.
    //
    // Pinning does not strand the terminal residue - on this helix the whole
    // displacement is 0.071 A - it DRAGS THE NEIGHBOUR, which has one fixed
    // point to average against and travels 0.441 A, six times too far, landing
    // 0.382 A off the helix. So the last turn of every duplex was pulled off
    // its own axis, which is what "the ends are not smoothed like the middle"
    // looks like from the outside.
    const src = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    const sandbox = {
        window: { addEventListener() {}, dispatchEvent() {} },
        document: { createElement: () => ({ getContext: () => null }) },
        console, performance: { now: () => Date.now() }, Event: function () {},
    };
    sandbox.window.window = sandbox.window;
    require('vm').createContext(sandbox);
    require('vm').runInContext(src, sandbox, { filename: 'cartoon' });
    const api = sandbox.window.py2dmolCartoon;
    if (!api || !api.smoothNucleicTrace) {
        throw new Error('smoothNucleicTrace is not exported, so nothing can test it');
    }
    const R = 9.0; const RISE = 3.38; const TW = 36 * Math.PI / 180;   // B-DNA
    const N = 24; const CUT = 12;
    const ideal = [];
    for (let i = 0; i < N; i++) {
        ideal.push({ x: R * Math.cos(i * TW), y: R * Math.sin(i * TW), z: i * RISE });
    }
    const run = (pts) => api.smoothNucleicTrace(pts, pts.length,
        new Array(pts.length).fill('D'), [[0, pts.length - 1]], null);
    const whole = run(ideal);
    const piece = run(ideal.slice(0, CUT));
    // the filter must actually be doing something, or this passes vacuously
    const moved = Math.hypot(whole[6].x - ideal[6].x, whole[6].y - ideal[6].y,
        whole[6].z - ideal[6].z);
    if (!(moved > 1e-3)) throw new Error('the smoothing moved nothing at all');
    for (let i = 0; i < CUT; i++) {
        const d = Math.hypot(piece[i].x - whole[i].x, piece[i].y - whole[i].y,
            piece[i].z - whole[i].z);
        // 0.01 A is a twentieth of what pinning costs the neighbour and well
        // above the arithmetic
        if (d > 0.01) {
            throw new Error(`cutting the helix moved residue ${i} by ${d.toFixed(3)} A`
                + ' - the run ends are not getting the displacement they would'
                + ' have had (pinning them costs the NEIGHBOUR 0.382 A)');
        }
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
    // ...named through mergedObjectSet, because several objects can be on
    // screen and each carries its own set in its own numbering
    if (!/mergedObjectSet\('bases', 'all'\)/.test(sig)
        || !/idOf\(b\)/.test(sig)) {
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
    // SWITCHING ELEMENTS OFF IS GEOMETRY TOO, for the reason the halves term
    // in the same signature gives: a bond whose ends differ is CUT at its
    // midpoint when the mesh is captured. The halves term is a LENGTH, and the
    // array keeps its length whatever is in it, so it cannot see the uncut.
    if (!/mergedObjectSet\('elements', 'all'\)/.test(sig) || !/idOf\(e\)/.test(sig)) {
        throw new Error('the mesh signature does not name the element set, so'
            + ' switching element colours off leaves the cut mesh on screen');
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
    // The ceiling keeps a zoomed-in band an annotation rather than a slab -
    // but PROPORTIONALLY. It used to be a flat 14 px, and that is the size at
    // which the band stops following what it marks: a ribbon never reaches it,
    // so the rule looked right, while anything big on screen - a metal at zoom
    // 4 is 27 px against a helix's 7 - had its margin held while it kept
    // growing. Reported as the highlight not tracking the zoom. The bound is
    // therefore the gain itself: 1 + 1.3 as a radius, and never more.
    const reach = zoomedIn / 2 / (34.6 * 0.5);
    if (reach > 1 + SELECTION_HALO_GAIN + 0.02) {
        throw new Error('the reach is uncapped: ' + reach.toFixed(2) + 'x');
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


t('a ligand row is Colour, Show, and Elements while it is shown', () => {
    // THE SAME SHAPE AS THE SIDE-CHAIN ROW, because it is the same question:
    // colour the thing, draw the thing, colour its atoms by element once it is
    // drawn. What differs is what each control reaches - see ligandRowPositions.
    const types = { 4: 'L', 5: 'L' };
    const lig = panelRun([4, 5], new Set(), false, types, null, new Set([4, 5]));
    if (lig.sidechainRow.hidden !== false) {
        throw new Error('the row is hidden for a ligand, so its colour, its Show'
            + ' and its elements cannot be reached at all');
    }
    if (lig.sidechainRow.label.textContent !== 'Ligand') {
        throw new Error('the row still calls itself Side chains over a ligand');
    }
    if (lig.sidechainRow.swatch.hidden !== false) {
        throw new Error('the ligand row has no colour swatch');
    }
    if (lig.sidechainShowToggle.label.hidden !== false) {
        throw new Error('the ligand row has no Show switch');
    }
    if (lig.sidechainShowToggle.checked !== true) {
        throw new Error('a ligand nobody has hidden reads as not shown');
    }
    if (lig.plateShowToggle.label.hidden !== true) {
        throw new Error('the Plate switch is on a ligand row - a ligand has no'
            + ' plate to draw');
    }
    if (lig.elementsShowToggle.label.hidden !== false) {
        throw new Error('Elements is hidden for a ligand that is drawn');
    }
    // MAIN CHAIN IS NOT A LIGAND'S ROW: its Show switches a backbone that is
    // not there, and its swatch sets the very colour the row above now sets.
    if (lig.mainchainRow.hidden !== true) {
        throw new Error('the Main chain row is offered for a ligand');
    }
    // ...and with the ligand hidden there is nothing to colour by element
    const off = panelRun([4, 5], new Set(), false, types, null, new Set([4, 5]),
        new Set());
    if (off.sidechainShowToggle.checked !== false) {
        throw new Error('a hidden ligand still reads as shown');
    }
    if (off.elementsShowToggle.label.hidden !== true) {
        throw new Error('Elements is offered for a ligand that is not drawn');
    }
    // ...and a protein selection is untouched by any of that
    const prot = panelRun([4, 5], new Set([4, 5]), false, { 4: 'P', 5: 'P' },
        new Set([4, 5]));
    if (prot.sidechainRow.label.textContent !== 'Side chains') {
        throw new Error('a protein row was renamed');
    }
    if (prot.mainchainRow.hidden !== false) {
        throw new Error('a protein lost its Main chain row');
    }
    if (prot.sidechainShowToggle.label.hidden !== false) {
        throw new Error('a protein lost its Show switch');
    }
    // A MIXED SELECTION IS A SIDE-CHAIN ROW. One ligand atom joining a dozen
    // residues must not take the side-chain controls away from the residues
    // that have them.
    const mixed = panelRun([4, 5], new Set([4]), false, { 4: 'P', 5: 'L' },
        new Set([4]), new Set([5]));
    if (mixed.sidechainRow.label.textContent !== 'Side chains') {
        throw new Error('a selection with one ligand atom in it was renamed');
    }
    if (mixed.mainchainRow.hidden !== false) {
        throw new Error('a mixed selection lost its Main chain row');
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
        // the panel reloads through reloadDrawn now, which keeps a merge up
        reloadDrawn() { this._loaded = (this._loaded || 0) + 1; },
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
    // ...through reloadDrawn, which reloads the frame OR rebuilds the merge -
    // reloading the frame while several objects are on screen throws the rest
    // of them off it.
    if (!/reloadDrawn/.test(handler)) {
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
// THE NUMBER IS SECONDS, so the field has to say seconds. The row is already
// called Turn - it names what gets made - and the field beside it said Turn
// again, which reads as a count of turns and is not one: the recording is
// exactly one revolution, and this is how long that revolution takes.
t('the capture panel calls its seconds field Sec, and says so once', () => {
    // The row is called Video and the field is Sec. It used to be a row called
    // Turn with a field called Turn beside it, which reads as a count of
    // revolutions and is not one: the recording is exactly one revolution, and
    // the number is how long that takes.
    const body = capturePanelBody();
    if (!/num\('saveSecondsInput', 'Sec'/.test(body)) {
        throw new Error('the seconds field is not labelled Sec');
    }
    if (!/'Length in seconds'/.test(body)) {
        throw new Error('nothing says what the seconds are');
    }
    // ...AND NO TOOLTIP IS A PARAGRAPH. A hover caption is read in the second
    // before the pointer moves on; the reasoning behind a default belongs in
    // the source, where it is, not in a box over the control.
    for (const m of body.matchAll(/(?:title|tip)\s*[:=]\s*'([^']+)'/g)) {
        if (m[1].length > 34) {
            throw new Error('a tooltip is a sentence again: "' + m[1] + '"');
        }
    }
    // ONE set of video settings, not one per output. Two rows each carrying
    // their own frame rate is how the same number came to be two controls.
    for (const id of ['saveSecondsInput', 'saveFpsInput', 'saveMbpsInput']) {
        const n = body.split(id).length - 1;
        if (n !== 1) throw new Error(id + ' appears ' + n + ' times - the video'
            + ' settings must exist once, not once per output');
    }
    // ...and the turn is a whole number of revolutions over the whole
    // recording, which is what makes "seconds" mean the length of the file
    if (!/const step = \(2 \* Math\.PI \* turns\) \/ N;/.test(src)) {
        throw new Error('the turn is not a whole number of revolutions');
    }
});

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
// A helper both panel tests use: the METHOD BODY, brace-matched. Slicing to
// the first "\n        }" reads somebody else's body the moment the method
// grows a nested block, which is how one of these first reported a feature
// missing while it was there.
// ONE METHOD'S BODY, brace-matched. Slicing to the first "\n        }" reads
// past the end the moment the method has a nested block - which is how a check
// on _deliverVideo went on passing with the line it checks for deleted.
function methodBody(name) {
    const at = src.indexOf('\n        ' + name + '(');
    if (at < 0) throw new Error(name + ' is gone');
    let d = 0; let k = src.indexOf('{', at);
    const start = k;
    for (; k < src.length; k++) {
        if (src[k] === '{') d++; else if (src[k] === '}' && !--d) break;
    }
    return src.slice(start, k + 1);
}

function capturePanelBody() {
    // the BUILDER, which is where the controls are; _toggleSaveImagePanel is
    // now just open-or-close around it
    const at = src.indexOf('        _buildSavePanel(anchorEl) {');
    if (at < 0) throw new Error('_buildSavePanel is gone');
    let d = 0; let k = src.indexOf('{', at);
    const start = k;
    for (; k < src.length; k++) {
        if (src[k] === '{') d++; else if (src[k] === '}' && !--d) break;
    }
    return src.slice(start, k + 1);
}

// EVERY FORMAT'S SINK IS BUILT AND DRIVEN, here, in Node.
//
// The panel tests read source text and the recorders are DOM-and-MediaRecorder
// deep, so nothing in this file used to run _makeVideoSink at all - and a
// one-word slip in it (a `const zip` that never landed) threw ReferenceError on
// the FIRST frame of every recording, in every format. Worse, the throw
// happened after the panel had marked itself busy, so every button in it went
// dead and stayed dead: reported as "Capture, Rotate, Turn does not record" and
// "the GIF path is broken", which are the same bug. This builds a sink for each
// format against stubs and pushes frames through it.
t('a GIF is always cut out, and says so once', () => {
    const body = capturePanelBody();
    const src2 = src;
    // A CHOICE THAT IS ALWAYS THE SAME ANSWER IS NOT A CHOICE. Paper or Clear
    // was one more control on the widest row in the panel, and a turn dropped
    // onto a slide or a dark page wants the cut-out far more often than it
    // wants a white square around the structure. PNG already exports this way.
    if (/saveGifBackground/.test(body)) {
        throw new Error('the background choice is back on the row');
    }
    if (!/const clear = gif;/.test(src2)) {
        throw new Error('a GIF is no longer always transparent');
    }
    // ...and the limits are not spelled out beside the format: they are
    // applied to the controls themselves (fps max, sizes greyed out), which is
    // where a limit belongs.
    if (/fps max, \$\{LIM\.maxPx\}px max/.test(body)) {
        throw new Error('the static limits note is back');
    }
    if (!/fpsIn\.max = gif \? LIM\.maxFps : 60/.test(body)) {
        throw new Error('the fps cap no longer reaches the control');
    }
    // THE PALETTE MENU IS NAMED LIKE THE REST OF THE ROW. Sec, FPS, Mbps and
    // Size all say what they are in front of the value; the colour menu used
    // to repeat its unit inside every option instead - "256 col", four times.
    if (/label: '\d+ col'/.test(body)) {
        throw new Error('the colour options spell out their unit again');
    }
    if (!/pair\('Color', 'saveGifColors'/.test(body)) {
        throw new Error('the colour menu has no caption');
    }
    // A LABEL AND ITS FIELD ARE ONE THING. The row wraps, and a bare label
    // followed by a bare input is two wrappable items - so a break landed
    // between them and left "FPS" at the end of one line with its box at the
    // start of the next. Each pair is a nowrap group, which also means one
    // thing to hide rather than two that can disagree.
    if (!/show\(colorsBox, gif\)/.test(body)) {
        throw new Error('the colour pair does not hide as one');
    }
    // ...AND SHOWING ONE PUTS ITS GRID BACK. `style.display = ''` removes the
    // inline declaration, which is where display:grid lives - so a pair hidden
    // and shown again became a plain block, its field kept width:100%, and it
    // hung its own label's width out of the panel.
    if (!/node\.style\.display = on \? 'grid' : 'none'/.test(body)) {
        throw new Error('showing a pair no longer restores its grid');
    }
    if (/\w+(Box|L)\.style\.display = [^;]*\?\s*''/.test(body)) {
        throw new Error("a pair is shown with display = '' again");
    }
});

t('a recording is exactly the frames it was handed', () => {
    const sink = methodBody('_makeVideoSink');
    // captureStream(fps) samples the canvas on its OWN clock as well as
    // accepting requestFrame, so every rendered frame went in twice over: a
    // 6-frame trajectory came out a 12-frame video, twice the length the panel
    // promised. 0 means "only what you hand me".
    if (!/captureStream\(0\)/.test(sink)) {
        throw new Error('the stream samples on its own clock again');
    }
    if (!/catch \(e\) \{ stream = target\.captureStream\(fps\); \}/.test(sink)) {
        throw new Error('no fallback for a browser that refuses a manual stream');
    }
    // ...and the trajectory is paced by the frame rate that was asked for. A
    // file is timestamped by the wall clock, so how long a frame is held IS
    // the frame rate - and this used to hold each one for the viewer's
    // animation speed, which has nothing to do with the FPS box.
    const seq = methodBody('recordFrameSequence');
    if (!/const captureDelay = Math\.max\(1000 \/ 60, 1000 \/ fps2\)/.test(seq)) {
        throw new Error('the trajectory is not paced by the chosen frame rate');
    }
    if (/this\.animationSpeed/.test(seq)) {
        throw new Error('the trajectory is paced by the animation speed again');
    }
});

t('every capture format builds a sink and finishes a file', () => {
    const realMR = global.MediaRecorder;
    const realZip = global.JSZip; const realGif = global.window.py2dmolGif;
    const realTimeout = global.setTimeout;
    global.MediaRecorder = function (stream, opts) {
        this.opts = opts; this.state = 'recording';
        this.start = () => {};
        this.stop = () => { if (this.ondataavailable) this.ondataavailable({ data: { size: 5 } });
            if (this.onstop) this.onstop(); };
    };
    global.MediaRecorder.isTypeSupported = (m) => /webm|mp4/.test(m);
    global.JSZip = function () {
        this.file = () => {};
        this.generateAsync = () => ({ then: (f) => { f({ size: 99, type: 'application/zip' }); return { catch() {} }; } });
    };
    global.window.py2dmolGif = () => ({ size: 77, type: 'image/gif' });
    global.setTimeout = (fn) => { fn(); return 0; };   // drive the async tails
    global.Blob = global.Blob || function (parts, o) { this.size = 1; this.type = o && o.type; };
    try {
        const v = new Cls();
        v.canvas = mkCanvas(600, 400);
        v.ctx = v.canvas.getContext('2d');
        v.displayWidth = 600; v.displayHeight = 400;
        v.backgroundColor = '#fff'; v.isTransparent = false;
        v.currentObjectName = 'obj';
        v._renderToContext = () => { v._rendered = (v._rendered || 0) + 1; };
        v._captureStatus = () => {};
        v.render = () => { v._screen = (v._screen || 0) + 1; };
        const ids = v.videoFormats().map((f) => f.id);
        if (ids.join() !== 'webm,mp4,gif,zip') {
            throw new Error('formats under stubs: ' + ids.join());
        }
        for (const id of ids) {
            for (const scale of [1, 2]) {
                const sink = v._makeVideoSink({ container: id, fps: 10, seconds: 1,
                    mbps: 5, scale, dpi: 96, colors: 64 });
                if (!sink) throw new Error(id + ' built no sink at ' + scale + 'x');
                sink.frame(); sink.frame();
                let got = null;
                sink.finish((blob, ext) => { got = { blob, ext }; });
                if (!got) throw new Error(id + ' never finished at ' + scale + 'x');
                if (!got.blob) throw new Error(id + ' finished with no file at ' + scale + 'x');
                if (!(sink.width > 0 && sink.height > 0)) {
                    throw new Error(id + ' has no size: ' + sink.width + 'x' + sink.height);
                }
                // ...and one render per frame, never two
                if (sink.rendersItself && !v._rendered) {
                    throw new Error(id + ' says it renders and then does not');
                }
            }
        }
        // the Images format takes its size from the dpi, not from the scale
        const a = v._makeVideoSink({ container: 'zip', dpi: 96, scale: 3, fps: 10 });
        const b = v._makeVideoSink({ container: 'zip', dpi: 192, scale: 1, fps: 10 });
        if (a.width !== 600 || b.width !== 1200) {
            throw new Error('Images ignored the dpi: ' + a.width + ' then ' + b.width);
        }
        // ...and a GIF is clamped, whatever it is asked for
        const g = v._makeVideoSink({ container: 'gif', fps: 60, scale: 3, colors: 64 });
        if (g.fps !== Cls.GIF_LIMITS.maxFps) throw new Error('GIF fps not clamped: ' + g.fps);
        if (Math.max(g.width, g.height) > Cls.GIF_LIMITS.maxPx) {
            throw new Error('GIF size not clamped: ' + g.width + 'x' + g.height);
        }
    } finally {
        global.MediaRecorder = realMR;
        global.JSZip = realZip; global.window.py2dmolGif = realGif;
        global.setTimeout = realTimeout;
    }
});

t('one capture model: defaults, formats and sizes', () => {
    const v = new Cls();
    const d = Cls.CAPTURE_DEFAULTS;
    if (d.dpi !== 200) throw new Error('the image default is ' + d.dpi + ' dpi, not 200');
    // A CEILING, NOT A TARGET: measured, the encoder spends about half of what
    // it is allowed on flat cartoon colour (asked 5, spent 2.6; asked 20, spent
    // 9.8), so headroom is nearly free and thin bitrates only show at 2x and 3x
    // where 5 Mbps is 0.12 bits a pixel.
    if (d.mbps !== 12) throw new Error('the video default is ' + d.mbps + ' Mbps, not 12');
    // the panel writes back into ONE object, and everything reads it through
    // captureOpts - the old pair of them defaulted 300 dpi in two places
    v._captureOpts = { dpi: 600 };
    if (v.captureOpts().dpi !== 600) throw new Error('a written option was lost');
    if (v.captureOpts().fps !== d.fps) throw new Error('the untouched defaults were dropped');
    // ...AND A CONTROL THAT IS NOT ON THE ROW LEAVES ITS SETTING ALONE. The
    // fallbacks in readVideo used to be literals, so opening the panel with
    // nothing recordable - no video row at all - wrote them over the settings:
    // the bitrate came back 5 where the default is 12, because 5 was the
    // number written in that function.
    const panel = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const rv = panel.slice(panel.indexOf('const readVideo = () => {'),
        panel.indexOf('const closePanel') > 0 ? panel.indexOf('const closePanel')
            : panel.indexOf('const recRow'));
    if (/\|\| \d+ :/.test(rv) || /: \d+,/.test(rv)) {
        throw new Error('readVideo has literal fallbacks again, so an absent'
            + ' control overwrites a setting');
    }

    // FORMATS ARE ASKED, NEVER ASSUMED. A format that cannot be written must
    // not be in the menu: a recording that fails afterwards has cost the take.
    const withMR = (types, gif) => {
        const oldMR = global.MediaRecorder;
        const oldGif = global.window.py2dmolGif;
        global.MediaRecorder = { isTypeSupported: (m) => types.some((t) => m.startsWith(t)) };
        global.window.py2dmolGif = gif ? (() => {}) : undefined;
        try { return v.videoFormats().map((f) => f.id); }
        finally { global.MediaRecorder = oldMR; global.window.py2dmolGif = oldGif; }
    };
    if (withMR(['video/webm'], false).join() !== 'webm') {
        throw new Error('a webm-only browser was offered something else');
    }
    if (withMR(['video/webm', 'video/mp4'], false).join() !== 'webm,mp4') {
        throw new Error('MP4 is not offered where MediaRecorder can write it');
    }
    if (withMR(['video/webm'], true).join() !== 'webm,gif') {
        throw new Error('GIF is not offered where the encoder is loaded');
    }
    // ...and NOT where it is missing, which is the notebook: viewer.html loads
    // py2Dmol's own resources and nothing else, so web/utils.js is not there.
    if (withMR(['video/webm'], false).includes('gif')) {
        throw new Error('GIF is offered without an encoder to write it');
    }

    // SIZES COME FROM THE CANVAS, in real pixels, and are even - H.264 refuses
    // an odd dimension outright.
    v.canvas = { width: 1001, height: 777 };
    const sizes = v.videoSizes();
    if (!sizes.length) throw new Error('no sizes at all');
    for (const z of sizes) {
        if (z.w % 2 || z.h % 2) throw new Error('an odd dimension: ' + z.label);
    }
    const one = sizes.find((z) => z.scale === 1);
    if (!one || (one.w !== 1002 && one.w !== 1000)) {
        throw new Error('1x is not the canvas size: ' + (one && one.w));
    }
    if (!sizes.some((z) => z.scale === 2)) throw new Error('no 2x option');
    // SMALLER TOO. A half-size recording is a quarter of the pixels, which is
    // what a GIF or a slide wants; the only size on offer used to be whatever
    // the canvas happened to be.
    if (!sizes.some((z) => z.scale < 1)) throw new Error('no smaller-than-screen option');
    if (sizes.some((z) => z.w < 64 || z.h < 64)) throw new Error('a thumbnail-sized option');
    // ...and the MENU says the multiplier, because the line under the row
    // already says what the file will be. Two places for one number, and the
    // menu was the widest control in a 160px panel because of it.
    const want = { 0.25: '1/4', 0.5: '1/2', 1: '1', 2: '2', 4: '4' };
    for (const z of sizes) {
        if (z.label !== want[z.scale]) {
            throw new Error('the size menu reads '
                + JSON.stringify(sizes.map((y) => y.label))
                + ' - fractions are fractions, and the x repeats the label');
        }
    }
    v.canvas = { width: 3000, height: 3000 };
    if (v.videoSizes().some((z) => z.w > 4096)) {
        throw new Error('a size past the 4096 encoder limit was offered');
    }
});

t('the GIF encoder writes a GIF, and only the web app has one', () => {
    // Written here rather than loaded, and gated by WHERE it is loaded: the
    // notebook viewer pulls in py2Dmol's own resources and nothing else.
    const u = fs.readFileSync('web/utils.js', 'utf8');
    if (!/window\.py2dmolGif = py2dmolGif/.test(u)) {
        throw new Error('the encoder is not exposed for the panel to find');
    }
    const vh = fs.readFileSync('py2Dmol/resources/viewer.html', 'utf8');
    if (/utils\.js|py2dmolGif|cdn/i.test(vh)) {
        throw new Error('the notebook viewer picked up an external dependency');
    }
    // and it really encodes: header, frame count, and pixels that come back
    const sandbox = { window: {}, console, Blob: class { constructor(p, o) { this.parts = p; this.type = o && o.type; } } };
    sandbox.window.window = sandbox.window;
    require('vm').createContext(sandbox);
    require('vm').runInContext(u, sandbox, { filename: 'utils' });
    const W = 32; const H = 24;
    const frames = [0, 1].map((f) => {
        const a = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < a.length; i += 4) {
            a[i] = f ? 200 : 20; a[i + 1] = 40; a[i + 2] = 90; a[i + 3] = 255;
        }
        return a;
    });
    const blob = sandbox.window.py2dmolGif(frames, { width: W, height: H, delayCs: 5 });
    if (blob.type !== 'image/gif') throw new Error('not a GIF blob');
    const bytes = Buffer.from(blob.parts[0]);
    if (bytes.slice(0, 6).toString() !== 'GIF89a') throw new Error('bad header');
    // two image descriptors, one per frame
    let images = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x2C) images++;
    if (images < 2) throw new Error('only ' + images + ' frames were written');
    if (!bytes.includes(Buffer.from('NETSCAPE2.0'))) {
        throw new Error('no loop block - the GIF plays once and stops');
    }
});

t('the capture panel says everything in one line, inside itself', () => {
    const body = capturePanelBody();
    const src2 = src;
    // ONE BOX. The panel used to talk through the page's status line - from a
    // panel that had closed itself when the job started, so the feedback for an
    // action appeared somewhere the user was no longer looking, under whatever
    // the loader said last. The embedded viewer has no status line at all.
    if (!/dataset\.info = '1'/.test(body)) {
        throw new Error('the panel has no info line');
    }
    // ...BEHIND ITS OWN RULE. Flush under the Video row it reads as one more
    // of that row's readouts - a size for the recording - when it describes
    // the image above as well and reports whatever was last written.
    if (!/rule\(\);\s*\n\s*const info = el\('div'/.test(body)) {
        throw new Error('the info line is not separated from the video row');
    }
    if (!/_captureStatus\(/.test(body)) throw new Error('the panel never writes to it');
    // ...and no capture path may go around it
    const stray = [];
    for (const m of src2.matchAll(/setStatus\(`?([A-Za-z][^`',]{0,40})/g)) {
        if (/export|Recording|Encoding|Zipping|Rendering frame|Saved|video data/i.test(m[1])) {
            stray.push(m[1]);
        }
    }
    if (stray.length) {
        throw new Error('capture feedback still goes to the page status line: '
            + JSON.stringify(stray));
    }
    // THE PANEL STAYS UP while it records, or the line it writes to is gone
    if (/closePanel\(\)/.test(body)) {
        throw new Error('a record button still closes the panel');
    }
    if (!/this\._captureBusy = true;/.test(body)) {
        throw new Error('nothing marks the panel busy, so a second job can start'
            + ' on top of the first');
    }
    if (!/_syncCaptureButtons\(\)/.test(body)) {
        throw new Error('the buttons are not disabled while a job runs');
    }
    // ...and the description follows the settings
    if (!/_describeCapture\(\)/.test(body)) {
        throw new Error('nothing describes what the settings will produce');
    }
    // THE VIEW STAYS STILL WHEN A RECORDING ENDS. The record button lifts the
    // panel's pause so the recorder can drive its own frames, and the
    // recorders hand auto-rotate back when they finish - so the structure
    // started spinning again the moment a take ended, under a panel whose job
    // is to hold it still while the next one is set up.
    const deliver = methodBody('_deliverVideo');
    if (!/if \(this\._savePanel\) this\._pauseForSavePanel\(\);/.test(deliver)) {
        throw new Error('the spin restarts under an open capture panel');
    }
});

t('the capture panel follows the window size', () => {
    // EVERY PIXEL FIGURE IN IT IS DERIVED FROM THE CANVAS - the image size, the
    // recording sizes, the whole Video menu - and all of them were computed
    // when the panel was built, so dragging the window wider left the panel
    // promising the old numbers.
    const at = src.indexOf('        _updateCanvasDimensions() {');
    const body = src.slice(at, src.indexOf('\n        }', at));
    if (!/_rebuildSavePanel\(true\)/.test(body)) {
        throw new Error('a resize does not refresh the capture panel, or does'
            + ' not clear a line describing the size it used to be');
    }
    if (!/!this\._captureBusy/.test(body)) {
        throw new Error('the panel would be rebuilt out from under a running job');
    }
    // the rebuild is safe only because the values live on the renderer
    const panel = capturePanelBody();
    if (!/const commit = \(\)/.test(panel) || !/addEventListener\('change', commit\)/.test(panel)) {
        throw new Error('the controls do not write back on change, so a rebuild'
            + ' would lose what was typed');
    }
});

t('a recorded frame is rendered once, at the size it is recorded', () => {
    // THE COST OF GETTING THIS WRONG, measured: the recorders rendered to the
    // screen and then again into the offscreen canvas, so every frame was
    // drawn twice at two different sizes. On the 2D path that is double the
    // work (4HHB, 2x: 73 ms a frame against 36). On the GPU path it is far
    // worse - the mesh cache is keyed on output size, so 598 px and 1196 px
    // alternating REBUILT THE MESH TWICE A FRAME: 91 ms a frame against about
    // nothing once the rebuild stops.
    const sink = (() => {
        const at = src.indexOf('        _makeVideoSink(opts) {');
        if (at < 0) throw new Error('_makeVideoSink is gone');
        let d = 0; let k = src.indexOf('{', at);
        const start = k;
        for (; k < src.length; k++) {
            if (src[k] === '{') d++; else if (src[k] === '}' && !--d) break;
        }
        return src.slice(start, k + 1);
    })();
    if (!/const blit = \(\) =>/.test(sink)) {
        throw new Error('the offscreen frame is not shown on screen - either the'
            + ' picture freezes while recording, or somebody put the second'
            + ' render back');
    }
    if (!/if \(octx\) \{ paint\(\); blit\(\); \}/.test(sink)) {
        throw new Error('frame() no longer renders at the recording size');
    }
    if (!/rendersItself/.test(sink)) {
        throw new Error('the sink does not say whether it renders, so the'
            + ' trajectory recorder cannot know to stop rendering too');
    }
    // ...and no recorder renders beside it
    for (const name of ['saveRotationVideo', 'saveDrawingVideo']) {
        const at = src.indexOf('        ' + name + '(opts) {');
        let d = 0; let k = src.indexOf('{', at);
        const start = k;
        for (; k < src.length; k++) {
            if (src[k] === '{') d++; else if (src[k] === '}' && !--d) break;
        }
        const body = src.slice(start, k + 1);
        const drives = body.match(/this\.render\([^)]*\);\s*\n\s*sink\.frame\(\)/);
        if (drives) throw new Error(name + ' renders and then records - two'
            + ' renders a frame, at two sizes');
    }
    const traj = src.slice(src.indexOf('        recordFrameSequence() {'));
    if (!/!this\._recSink \|\| !this\._recSink\.rendersItself/.test(traj)) {
        throw new Error('the trajectory recorder renders unconditionally');
    }
});

t('the save panel can still record a trajectory', () => {
    const body = capturePanelBody();
    // FOUR WAYS TO PUT A TRAJECTORY AND A TURN IN ONE FILE, named for what
    // they are and differing in WHO SETS THE LENGTH:
    //   F  frames once, no turning        (the trajectory sets it)
    //   FR frames once, rotation fitted   (the trajectory sets it)
    //   RF a timed turn, frames fitted    (you set it)
    //   R  a timed turn                   (you set it)
    for (const id of ["'F'", "'FR'", "'RF'", "'R'"]) {
        if (!new RegExp("id: " + id + ",").test(body)) {
            throw new Error('no source ' + id);
        }
    }
    if (!/timed: false/.test(body) || !/timed: true/.test(body)) {
        throw new Error('the sources no longer say who sets the length, so the'
            + ' panel cannot know whether Sec means anything');
    }
    // The Record row lists one button per SOURCE, and Frames is the one that
    // came from a separate record button in the controls bar. It has to be
    // gated on there being frames to play: the old button did not gate itself
    // and silently did nothing on a single-frame structure, which is the
    // confusion the panel exists to end.
    if (!/frames\.length > 1/.test(body)) {
        throw new Error('the Frames source is not gated on there being frames'
            + ' to play');
    }
    if (!/sources\.push\(\{ id: 'F',/.test(body)) {
        throw new Error('the panel has no frames source - recording the frames'
            + ' playing through was lost');
    }
    if (!/this\.toggleRecording\(vo\)/.test(body)) {
        throw new Error('the Frames source does not reach toggleRecording()');
    }
    // ...and the other two, each gated on the mode that makes it possible
    if (!/if \(spin\) \{\s*\n\s*sources\.push/.test(body)
        || !/if \(this\.drawMode\) \{/.test(body)) {
        throw new Error('Rotate and Draw are no longer gated on their modes');
    }
    // A TRAJECTORY CAN PLAY WHILE THE VIEW TURNS, and a drawing can build up
    // while it turns. Both recorders could always do it; with one button per
    // source there was no way to ASK for it - whether you got it depended on
    // whether Rotate happened to be on.
    // ...and the combination is what record MEANS when both are on: switching
    // Rotate on with a trajectory loaded is a request to see it turning.
    if (!/const preferred = sources\.find\(\(x\) => x\.id === 'FR'\)/.test(body)) {
        throw new Error('the combination is not the default when both are on');
    }
    // THE COUNT IS FOR A TURN OR A DRAWING. A trajectory has frames of its
    // own, so "Frames: 36" beside a Frames recording said something that is
    // not true of it - it is read off the PICKED source now, not off the list.
    if (!/const pickedId = srcSel \? srcSel\.value/.test(body)
        || !/pickedId === 'R' \|\| pickedId === 'D'/.test(body)) {
        throw new Error('the image count does not follow the picked source');
    }
    // SEC FOLLOWS THE SOURCE TOO. On F and FR the trajectory sets the length -
    // N frames at the chosen rate - and a seconds box there is a number that
    // either does nothing or silently drops frames.
    if (!/const timed = !!src\.timed;/.test(body)) {
        throw new Error('Sec is not gated on who sets the length');
    }
    if (!/show\(rotL, turns\)/.test(body)) {
        throw new Error('the rotation count is not gated on something rotating');
    }
    // ...and every pair is built by the one helper, or one of them splits again
    if (!/const pair = \(labelText, forId, control, tip\)/.test(body)) {
        throw new Error('there is no label-and-field group');
    }
    if (/vRow\.appendChild\(\w+L\); vRow\.appendChild/.test(body)) {
        throw new Error('a label and its field are appended separately again');
    }
    // ...and picking a source must WRITE it, or the description goes on
    // describing whichever source was last recorded - picking F still read
    // "1 turn" off the FR before it.
    if (!/srcSel\.addEventListener\('change', \(\) => \{ syncVideo\(\); commit\(\); \}\)/.test(body)) {
        throw new Error('the picked source is not committed');
    }
    // THE LINE WORKS THE LENGTH OUT rather than repeating the boxes: on F and
    // FR the trajectory sets it and the seconds are derived; on R and RF the
    // seconds set it and the frame count is derived.
    const desc = methodBody('_describeCapture');
    if (!/const led = \(src === 'F' \|\| src === 'FR'\) && nTraj > 1;/.test(desc)) {
        throw new Error('the description does not know who sets the length');
    }
    if (!/model frames fitted/.test(desc)) {
        throw new Error('RF does not say that the trajectory is fitted into it');
    }
    if (/num\('saveFrameCount', 'Frames'/.test(body)) {
        throw new Error('the count is called Frames again, beside a source of'
            + ' the same name that means something else');
    }
    // ONE BUTTON. A row of buttons reading Rotate, Frames, Draw+Rotate is a row
    // of sentences; the choice belongs in a menu beside the other menus.
    if (!/const recBtn = button\('\\u25CF'/.test(body)) {
        throw new Error('the record button is not a single dot');
    }
    // NOTHING THAT MATTERS MOVES. The panel is a grid - name, settings,
    // action - so both buttons live in a column of their own at the right and
    // hold their place whatever is showing between; and the source menu sits
    // beside the format, the two controls that decide which of the others are
    // there at all. Built in the order they were written, the source menu sat
    // AFTER the controls it governs and each button wherever its row's
    // settings left it: picking a source moved the menu you had just used, and
    // the button you were aiming at slid or wrapped.
    if (!/recRow\.insertBefore\(srcBox, vFmtBox \? vFmtBox\.nextSibling : null\)/.test(body)) {
        throw new Error('the source menu is not beside the format');
    }
    // EVERY CONTROL SAYS WHAT IT IS, and every one is the same shape - a
    // caption and a field - which is what makes the columns line up. A bare
    // menu reading "PNG" is only obvious while you already know what the row
    // does.
    for (const cap of ["pair\\('Type', 'saveFormatSelect'", "pair\\('DPI', 'saveDpiInput'",
        "pair\\('Type', 'saveVideoFormat'", "pair\\('Rec', 'saveVideoSource'"]) {
        if (!new RegExp(cap).test(body)) throw new Error('uncaptioned control: ' + cap);
    }
    if (!/recRow\.action\.appendChild\(recBtn\)/.test(body)
        || !/imgRow\.action\.appendChild\(okBtn\)/.test(body)) {
        throw new Error('the buttons are not in the action column');
    }
    if (!/grid-template-columns:auto minmax\(0,1fr\) auto/.test(body)) {
        throw new Error('the panel is not a grid, so the two rows line up only'
            + ' by accident');
    }
    if (!/saveVideoSource/.test(body)) {
        throw new Error('there is no menu for what to record');
    }
    if (!/saveRotationVideo\(Object\.assign/.test(body)
        || !/saveDrawingVideo\(vo\)/.test(body)) {
        throw new Error('a source no longer reaches its recorder');
    }
    // RF IS THE TURN WITH THE FRAMES FITTED IN: the rotation recorder already
    // drives its own frames on a clock, which is what "fit the trajectory into
    // this many seconds" needs, so it plays them rather than a second driver
    // being written.
    if (!/playFrames: src\.id === 'RF'/.test(body)) {
        throw new Error('RF does not play the frames');
    }
    if (!/const nFrames = \(o\.playFrames/.test(src)) {
        throw new Error('the rotation recorder cannot play a trajectory');
    }
    // with nothing recordable the row SAYS so rather than offering a dead button
    // NO ROW WHERE THERE IS NOTHING TO RECORD. A Vid row whose only content
    // is "you cannot" spends a rule, a name and a sentence on an absence; the
    // panel is rebuilt when Rotate or Draw goes on or a trajectory arrives, so
    // the row appears the moment it can do something.
    if (!/const recRow = videoRow \|\| \(!formats\.length/.test(body)) {
        throw new Error('a video row is still built with nothing to record');
    }
    if (/Needs Rotate, Draw or frames/.test(body)) {
        throw new Error('the empty-row sentence is back');
    }
    // ...except where the BROWSER has no recorder, which no amount of clicking
    // will fix and is worth saying
    if (!/No video recorder in this browser/.test(body)) {
        throw new Error('a browser with no recorder is not told so');
    }
    // ...and the buttons live ON the video row, not on one of their own: a row
    // called Record under a row called Video is a second name for one subject,
    // and a line break nobody asked for.
    if (/row\('Record'\)/.test(body)) {
        throw new Error('the record buttons are back on a row of their own');
    }
    if (!/const recRow = videoRow/.test(body)) {
        throw new Error('the record buttons do not join the Video row');
    }
});

// EVERY CONTROL IN THE PANEL IS THE SAME HEIGHT. The numbers were 46x24 at
// 12px, too small to read and - worse - a different weight from the row beside
// them, so with a video row and the still row both up it was not obvious which
// field belonged to which output. Reported directly.
t('the save panel sizes its controls consistently', () => {
    const body = capturePanelBody();
    const H = body.match(/const H = (\d+);/);
    if (!H) throw new Error('the panel has no single control height');
    const h = Number(H[1]);
    if (h < 26) {
        throw new Error("the panel's controls are " + h + 'px high - under 26'
            + ' they are hard to read and hard to hit');
    }
    // fields built from it, and the buttons too where the page has no skin of
    // its own to lend them
    for (const name of ['FIELD', 'BTN']) {
        const re = new RegExp('const ' + name + ' = `[^`]*height:\\$\\{H\\}px');
        if (!re.test(body)) throw new Error(name + ' is not derived from H');
    }
    // A BUTTON HERE LOOKS LIKE THE BUTTONS BESIDE IT. Save and Turn were the
    // only controls in the viewer with a hand-rolled skin, which is exactly
    // what a button should not have: the class is looked up from the page -
    // .btn.btn-grey.btn-small on index.html, .controlButton in the notebook -
    // and the inline style is the fallback for a page with neither.
    if (!/const button = \(text, title\)/.test(body)) {
        throw new Error('the panel builds its buttons by hand again');
    }
    if (!/'btn btn-grey btn-small', 'controlButton'/.test(body)) {
        throw new Error('the panel no longer borrows the page\'s button skin');
    }
    if (!/if \(skin\) b\.className = skin;/.test(body)) {
        throw new Error('the skin is looked up and then not put on the button');
    }
    for (const label of ["button\\('Save'", "button\\('\\\\u25CF'"]) {
        if (!new RegExp(label).test(body)) {
            throw new Error('a button skipped the shared builder: ' + label);
        }
    }
    if (!/const NUM = FIELD/.test(body)) {
        throw new Error('the number fields are not the same control as the menus');
    }
    if (/const CAP = 'font-size:11px/.test(body)) {
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
    if (!/id="plateShowToggle"/.test(html)) {
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
t('the CA-CB bond is as thick as the rest of the side chain', () => {
    // The bond joining a side chain to its backbone runs [owner, CB]. The
    // owner is a protein position, the segment builder takes the most
    // restrictive of the two types, so that link is type 'P' - and the width
    // rule asked for type 'L' before calling something a side chain. One bond
    // at the BACKBONE's full width with the rest of the side chain at half it,
    // worst in tube mode where the backbone is thickest.
    const v = new Cls();
    v.sidechainMap = new Map([[42, { owner: 7, el: 'C' }], [43, { owner: 7, el: 'C' }]]);
    v.typeWidthMultipliers = { P: 1.0, L: 0.4, C: 0.5 };
    v.lineWidth = 3;
    // CB to CG: both appended atoms, so type 'L' - this always worked
    const inner = v._calculateSegmentWidthMultiplier(null, { type: 'L', idx1: 42, idx2: 43 });
    // CA to CB: the owner is protein, so the segment is type 'P'
    const link = v._calculateSegmentWidthMultiplier(null, { type: 'P', idx1: 7, idx2: 42 });
    if (link !== inner) {
        throw new Error(`the CA-CB bond is ${link} wide against the side chain's`
            + ` ${inner} - one bond at a different weight from the rest of the`
            + ' thing it belongs to');
    }
    if (link !== SIDECHAIN_WIDTH) {
        throw new Error('the side chain is not at SIDECHAIN_WIDTH');
    }
    // ...and a real backbone segment is untouched: both ends are the chain
    const bb = v._calculateSegmentWidthMultiplier(null, { type: 'P', idx1: 7, idx2: 8 });
    if (bb !== 1.0) {
        throw new Error('the backbone was thinned to a side chain, ' + bb);
    }
});

t('the drawn objects are asked for in one place', () => {
    // GROUNDWORK for an Object list, not a feature. Several structures on
    // screen at once will be ONE MERGED coordinate array - the overlay already
    // does exactly that for the frames of a trajectory, down to handing the
    // per-source map to the cartoon as a bonding group so nothing joins across
    // sources. See MULTI_OBJECT_PLAN.md.
    //
    // What this pins is the question being asked in one place, so the day it
    // answers with several names, the callers need no changing.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('drawnObjects() {');
    if (at < 0) throw new Error('nothing owns the list of drawn objects');
    const body = mol.slice(at, mol.indexOf('\n        }', at));
    if (!/this\.shownObjects/.test(body) || !/this\.currentObjectName/.test(body)) {
        throw new Error('drawnObjects does not fall back to the current object,'
            + ' which is every session today');
    }
    // an object can be deleted while the set still names it
    if (!/for \(const name of Object\.keys\(all\)\)/.test(body)) {
        throw new Error('the shown set is trusted without checking the objects'
            + ' still exist');
    }
});

t('an object switch draws once, and after the frames are in', () => {
    // A switch is followed by half a dozen things that each ask for a render -
    // the visibility mask, the scatter, the sequence view, and app.js
    // re-running the Ortho slider - and every one of them fires while
    // this.coords still holds the PREVIOUS object, because the frames are
    // loaded by the caller afterwards. That was cheap while every object was
    // drawn the same way. Once the style travels with the object it is not:
    // switching to a small cartoon built a full cartoon of the ribosome still
    // in memory and threw it away. Measured on 4UG0 -> 6MRR, one
    // render('orthoSlider') of 1,146 ms with 17,550 positions loaded, to draw
    // a picture of 68 - and 38 ms for the whole switch once held.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const sw = mol.slice(mol.indexOf('_switchToObject(newObjectName) {'));
    const head = sw.slice(0, 1800);
    if (!/this\._switchQuiet = true/.test(head)) {
        throw new Error('nothing holds the renders back over a switch');
    }
    // ...RELEASED ON THE NEXT FRAME, by which time the caller has loaded the
    // frames - and then drawn once. Without the release the viewer would stop
    // drawing altogether, which is the failure this flag risks.
    if (!/requestAnimationFrame\(\(\) => \{[\s\S]{0,200}_switchQuiet = false/.test(head)) {
        throw new Error('the hold is never released on a frame');
    }
    if (!/_switchQuiet = false;[\s\S]{0,120}this\.render\(/.test(head)) {
        throw new Error('the hold is released without drawing, so the switch'
            + ' leaves the previous object on screen');
    }
    if (!/typeof requestAnimationFrame === 'function'/.test(head)
        || !/\} else \{[\s\S]{0,80}_switchQuiet = false/.test(head)) {
        throw new Error('with no requestAnimationFrame - a headless or export'
            + ' context - the flag is never cleared and nothing draws again');
    }
    if (!/if \(this\._quietStyle \|\| this\._switchQuiet\) return;/.test(mol)) {
        throw new Error('render does not honour the hold');
    }
});

t('a saved session carries each object\'s clip and style', () => {
    // _switchToObject moves the clip and the style on and off the renderer as
    // objects change, but the SAVE copied only the fields that live in
    // viewerState the whole time - so a session came back unclipped, and every
    // object came back in whatever style the session as a whole was saved in.
    const app = fs.readFileSync('web/app.js', 'utf8');
    const save = app.slice(app.indexOf('const isCurrent = objectName'),
        app.indexOf('objects.push(objToSave)'));
    for (const k of ['clipNear', 'clipFar', 'clipFade', 'style', 'styleChosen']) {
        if (!save.includes(k)) throw new Error('the save drops ' + k);
    }
    // ...taken off the RENDERER for the current object, because that is where
    // they live while an object is on screen
    if (!/const held = isCurrent \? renderer : sourceState/.test(save)) {
        throw new Error("the current object's clip and style are read from its"
            + ' stored state, which is only written when switching AWAY from it');
    }
    const load = app.slice(app.indexOf('renderer.objectsData[objData.name].viewerState = {'));
    const body = load.slice(0, load.indexOf('};'));
    for (const k of ['clipNear', 'clipFar', 'clipFade', 'style', 'styleChosen']) {
        if (!body.includes(k)) throw new Error('the load drops ' + k);
    }
    // an older session has none of these, and absent must read as "never set"
    if (!/style: vs\.style \|\| null/.test(body)) {
        throw new Error('a session saved before this will restore undefined as a style');
    }
});

t('the colour modes are ordered by how often they are reached for', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const at = html.indexOf('id="colorSelect"');
    const sel = html.slice(at, html.indexOf('</select>', at));
    const order = [...sel.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
    // Auto first because it is the answer most of the time, then the three
    // that apply to any structure, then the two that only mean anything on a
    // prediction. Entropy is last and hidden until an MSA is loaded, and
    // Object sits with the general schemes but is hidden until there is more
    // than one object on screen - with one it colours everything the same.
    const want = ['auto', 'rainbow', 'chain', 'object', 'ss', 'plddt',
        'deepmind', 'entropy'];
    const hiddenUntilUseful = [...sel.matchAll(/<option value="(\w+)"[^>]*hidden/g)]
        .map((m) => m[1]);
    for (const nm of ['object', 'entropy']) {
        if (!hiddenUntilUseful.includes(nm)) {
            throw new Error(nm + ' is offered before it means anything');
        }
    }
    if (order.join() !== want.join()) {
        throw new Error('the colour modes read ' + order.join(', ')
            + ' rather than ' + want.join(', '));
    }
});

t('a style belongs to its object, and a width to its style', () => {
    // OPEN A RIBOSOME AND THEN A PEPTIDE and the peptide arrived as a tube,
    // because the style was one setting for the whole viewer. It belongs to
    // the object: what is right for a ribosome is not right for the peptide
    // beside it, and switching between the two should not mean setting the
    // style again each time.
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const sw = mol.slice(mol.indexOf('_switchToObject(newObjectName) {'));
    const save = sw.slice(0, sw.indexOf('// Restore viewer state'));
    if (!/style: this\.style/.test(save) || !/styleChosen: !!this\.styleChosen/.test(save)) {
        throw new Error('the style does not travel with the object it was set on');
    }
    // ...QUIETLY: the frames are not in yet, so a draw here is built from the
    // previous object's coordinates (see the switch-draws-once test).
    if (!/this\.setStyle\(saved\.style, true\)/.test(sw)) {
        throw new Error('a switched-to object does not get its style back,'
            + ' or gets it loudly enough to draw the wrong structure');
    }
    // ...AND THE SIZE QUESTION IS ASKED ABOUT THE INCOMING OBJECT. The frames
    // are loaded by the caller, AFTER the switch, so this.coords is still the
    // previous object's here - a small structure following a huge one had its
    // cartoon refused on the huge one's size and came back as a tube.
    if (!/_cartoonWouldFit\(nPos\)/.test(sw)) {
        throw new Error('the cartoon fit is judged on whatever is still loaded,'
            + ' not on the object being switched to');
    }
    if (!/_cartoonWouldFit\(nPositions\)/.test(mol)) {
        throw new Error('the fit check cannot be asked about another object');
    }

    // A WIDTH BELONGS TO ITS STYLE. The slider is one control and not one
    // quantity: in tube it is the radius of the tube, in cartoon it scales the
    // ribbon. Dragged in tube it used to follow the switch and arrive as a
    // ribbon several times too wide - which is what "tube settings copied into
    // cartoon" was, once opening an object started switching style by itself.
    const v = new Cls();
    global.window = global.window || {};
    const DEF = { cartoon: { width: 3, thickness: 0, outlineTint: 0, highlight: 1.8,
        sheetFlat: 0, pencil: 0 }, tube: { width: 3, thickness: 0, outlineTint: 0,
        highlight: 1.8, sheetFlat: 0, pencil: 0 } };
    const had = global.window.py2dmolCartoon;
    global.window.py2dmolCartoon = { STYLE_DEFAULTS: DEF };
    try {
        v._widthByStyle = { tube: 4.5 };
        v.style = 'cartoon';
        v._applyStyleDefaults('cartoon');
        if (v.lineWidth !== 3) {
            throw new Error(`cartoon opened at width ${v.lineWidth} - the tube's`
                + ' 4.5 followed it across');
        }
        v.style = 'tube';
        v._applyStyleDefaults('tube');
        if (v.lineWidth !== 4.5) {
            throw new Error('tube did not get its own width back');
        }
        // ...AND NOT THROUGH ONE FLAG FOR BOTH STYLES, which is what this
        // replaced: a single "the user has taken the width over" latch stopped
        // the width following ANY switch once it was set, which is how a tube
        // radius arrived in cartoon as a ribbon width.
        if (/_lineWidthUserSet/.test(fs.readFileSync(
            'py2Dmol/resources/viewer-mol.js', 'utf8'))) {
            throw new Error('the single-latch width is back');
        }
    } finally {
        if (had === undefined) delete global.window.py2dmolCartoon;
        else global.window.py2dmolCartoon = had;
    }
});

t('a large structure opens as tube, and a chosen style is left alone', () => {
    // NOT the memory rule below it: this is about what is worth looking at.
    // Past a couple of thousand residues the ribbon is a tangle at any zoom
    // that fits it on screen, and the first thing to do with it is turn it
    // down.
    const app = fs.readFileSync('web/app.js', 'utf8');
    // ...AND WHERE THAT LINE IS DRAWN IS A DECISION, so it is written down
    // here too. The rule below is exercised with its own number, which would
    // go on passing whatever the shipped one drifted to.
    const cut = /const BIG_STRUCTURE_RESIDUES = (\d+);/.exec(app);
    if (!cut || +cut[1] !== 2000) {
        throw new Error('the tube cutoff is ' + (cut && cut[1])
            + ', not the 2000 it was set to - a thousand took the cartoon away'
            + ' from structures that still read perfectly well as one');
    }
    const at = app.indexOf('function tubeByDefaultIfBig(');
    if (at < 0) throw new Error('the size rule is gone from web/app.js');
    let d = 0; let k = app.indexOf('{', at);
    const start = k;
    for (; k < app.length; k++) {
        if (app[k] === '{') d++; else if (app[k] === '}' && !--d) break;
    }
    const body = app.slice(start, k + 1);
    // eslint-disable-next-line no-new-func
    const fn = new Function('r', 'objectName', 'BIG_STRUCTURE_RESIDUES', 'setStatus',
        'styleFallbackNote',
        body.slice(1, -1).replace(/styleFallbackNote = /g, 'void ') + '; return r;');
    // ...off the FRAME, which is where the count has to come from: the
    // renderer's own arrays are still the previous object's while this runs
    const viewer = (n, extra) => Object.assign({
        style: 'cartoon',
        objectsData: { o: { frames: [{ coords: new Array(n),
            position_types: Array.from({ length: n }, () => 'P') }] } },
        setStyle(v) { this.style = v; },
    }, extra || {});
    const big = viewer(1001);
    fn(big, 'o', 1000, () => {});
    if (big.style !== 'tube') throw new Error('1001 residues still opened on cartoon');
    const small = viewer(1000);
    fn(small, 'o', 1000, () => {});
    if (small.style !== 'cartoon') {
        throw new Error('1000 residues was pushed to tube - the rule is PAST a thousand');
    }
    // ...AND IT ANSWERS BOTH WAYS. The rule used to return unless the renderer
    // was already on cartoon, so the first big structure switched it to tube
    // and everything after it stayed there however small: load a ribosome,
    // fetch a peptide, get a tube. The decision is about the structure being
    // loaded, so it has to be able to come back.
    const afterBig = viewer(300, { style: 'tube' });
    fn(afterBig, 'o', 1000, () => {});
    if (afterBig.style !== 'cartoon') {
        throw new Error('a 300-residue structure loaded into tube because the'
            + ' one before it was a ribosome');
    }
    // ...and a style someone picked is theirs: loading a second structure must
    // not undo it
    const chosen = viewer(5000, { styleChosen: true });
    fn(chosen, 'o', 1000, () => {});
    if (chosen.style !== 'cartoon') {
        throw new Error('a hand-picked cartoon was overridden by the size rule');
    }
    // ...both ways round: a hand-picked TUBE survives a small structure too,
    // which is the case the "both ways" change above could have broken.
    const chosenTube = viewer(300, { style: 'tube', styleChosen: true });
    fn(chosenTube, 'o', 1000, () => {});
    if (chosenTube.style !== 'tube') {
        throw new Error('a hand-picked tube was undone by loading a small structure');
    }
    // A LIGAND IS NOT A RESIDUE. Counting coordinates would put a small
    // structure with a big ligand, or one showing its side chains, over the
    // line - both append positions of type 'L'.
    const ligandy = viewer(400);
    const lt = ligandy.objectsData.o.frames[0].position_types;
    for (let i = 0; i < 2000; i++) lt.push('L');
    ligandy.objectsData.o.frames[0].coords = new Array(lt.length);
    fn(ligandy, 'o', 1000, () => {});
    if (ligandy.style !== 'cartoon') {
        throw new Error('ligand atoms were counted as residues');
    }
    // THE FRAME, NOT THE RENDERER: reading renderer.positionTypes is what made
    // this fire for nothing, since it still holds the previous object's while
    // the switch is happening.
    const stale = viewer(1001);
    stale.positionTypes = [];
    fn(stale, 'o', 1000, () => {});
    if (stale.style !== 'tube') {
        throw new Error('the count came off the renderer, which is empty here -'
            + ' the rule then never fires on a first load');
    }
    // the two places that mark a style as chosen: the dropdown and a saved view
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (!/renderer\.styleChosen = true;/.test(mol)) {
        throw new Error('picking a style in the Style panel no longer records it,'
            + ' so the next load would choose again over the top of it');
    }
    if (!/renderer\.styleChosen = true;\s*\/\/ a saved view/.test(app)) {
        throw new Error('a restored session does not count as a chosen style');
    }
});

t('the JR palettes are gone, everywhere they were named', () => {
    // Purged rather than hidden: a palette left in the table but out of the
    // menu is still reachable from Python and from a saved session, and then
    // the two surfaces disagree about what exists.
    for (const f of ['py2Dmol/resources/viewer-cartoon.js',
        'py2Dmol/resources/viewer-mol.js', 'py2Dmol/viewer.py',
        'web/app.js', 'index.html', 'README.md']) {
        const src = fs.readFileSync(f, 'utf8');
        const hit = /\bjr[12]\b|\bJR[12]\b/.exec(src);
        if (hit) throw new Error(f + ' still names ' + hit[0]);
    }
    // ...and the palette table is down to the two that are left
    const cart = fs.readFileSync('py2Dmol/resources/viewer-cartoon.js', 'utf8');
    const at = cart.indexOf('const SS_PALETTES = {');
    const table = cart.slice(at, cart.indexOf('\n    };', at));
    const keys = (table.match(/^        (\w+): \{/gm) || []).map((m) => m.trim());
    if (keys.join(' ') !== 'pymol: { jmol: {') {
        throw new Error('the palette table holds ' + JSON.stringify(keys));
    }
    // the inner-colour branch only that palette fed goes with it
    if (/ssPal\.back/.test(cart)) {
        throw new Error('the per-class back colour is still read, and nothing'
            + ' supplies one any more');
    }
});

t('ligands are loaded by default, in the page and in the Python viewer', () => {
    // A LIGAND IS USUALLY WHY THE STRUCTURE IS OPEN. Left off, the viewer says
    // nothing about it and the file reads as not having one - and the two
    // controls have to agree, or the switch shows a state the loader is not in.
    const html = fs.readFileSync('index.html', 'utf8');
    const m = html.match(/<input[^>]*id="loadLigandsCheckbox"[^>]*>/);
    if (!m) throw new Error('the Load Ligands checkbox is gone from index.html');
    if (!/\bchecked\b/.test(m[0])) {
        throw new Error('the Load Ligands switch no longer starts on');
    }
    const app = fs.readFileSync('web/app.js', 'utf8');
    if (!/loadLigands:\s*true/.test(app)) {
        throw new Error('the config still starts with ligands off, so the switch'
            + ' shows on and the loader drops them');
    }
    const py = fs.readFileSync('py2Dmol/viewer.py', 'utf8');
    if (!/load_ligands=True/.test(py)) {
        throw new Error('the Python loader no longer defaults to loading ligands');
    }
});

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
        + grab('_segmentElementColor') + grab('_colorSegmentPosition')
        + grab('elementAt') + grab('_elementOwnerOf') + grab('sourceGroups')
        + grab('mergedObjectSet') + st[0]
        + ' _getEffectiveColorMode(){return "chain";}'
        + ' getAtomColor(){ return {r:9,g:9,b:9}; }'
        + '}')({ r: 255, g: 255, b: 0 });
    const v = new C();
    v.overlayState = { enabled: false };
    v.multiState = { enabled: false };
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
    // elementOwners is the real one, and builds from the table - so this is
    // the table, rather than one more stub that could disagree with it
    v.sidechains = { pos: owners.slice() };
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

// A LIGAND ATOM IS AN ATOM. It is a position of the file's own rather than a
// row of the side-chain table, so none of the side-chain machinery knows it -
// which is why colour-by-element skipped ligands entirely until its element was
// captured alongside its name.
t('a ligand atom carries its own name and element out of the file', () => {
    const u = fs.readFileSync('web/utils.js', 'utf8');
    const m = u.match(/function elementOfAtom\(atom\)[\s\S]*?\n\}/);
    if (!m) throw new Error('elementOfAtom is gone from web/utils.js');
    // eslint-disable-next-line no-new-func
    const el = new Function(m[0] + '; return elementOfAtom;')();
    if (el({ element: 'Cl', atomName: 'CL1' }) !== 'CL') {
        throw new Error('the element column was not used - a two-letter element'
            + ' can only be read there');
    }
    if (el({ element: '', atomName: 'N1' }) !== 'N') {
        throw new Error('a blank column left the atom with no element at all');
    }
    // ...and NEVER a two-letter guess off the name: haem names four nitrogens
    // NA, NB, NC, ND, and a guess turns one of them into sodium
    if (el({ element: '', atomName: 'NA' }) !== 'N') {
        throw new Error('a name was read as a two-letter element - that is a'
            + " haem nitrogen in every file that has no element column");
    }
    if (el({ element: '', atomName: '' }) !== '') {
        throw new Error('an element was invented out of nothing');
    }
});

t('a ligand bond takes its colours from the elements it joins', () => {
    // no side chains anywhere: this is the path that did not exist before, and
    // the one a ligand selection is entirely made of
    const v = new Cls();
    v.currentObjectName = 'obj';
    v.objectsData = { obj: {} };
    v.positionTypes = ['L', 'L', 'L'];
    v.positionElements = ['C', 'N', 'C'];
    v.sidechainMap = null;
    v.sidechains = null;
    const h = v._segmentElementHalves({ idx1: 0, idx2: 1, origIndex: 0 });
    if (!h) throw new Error('a carbon-nitrogen ligand bond took no element colours');
    if (h.a) throw new Error('the carbon half was coloured - carbon follows the residue');
    if (!h.b || h.b.b < 200) throw new Error('the nitrogen half is not the nitrogen blue');
    if (v._segmentElementHalves({ idx1: 0, idx2: 2, origIndex: 0 })) {
        throw new Error('an all-carbon ligand bond was given element colours');
    }
    // ...and the switch reaches it, atom by atom: a ligand atom owns itself
    if (!v.hasElementsFor([1])) throw new Error('the row is not offered for a ligand atom');
    if (v.hasElementsFor([9])) throw new Error('offered for a position that has no element');
    if (!v.setElementsFor([1], false)) throw new Error('switching a ligand atom off did nothing');
    if (v._segmentElementHalves({ idx1: 0, idx2: 1, origIndex: 0 })) {
        throw new Error('the bond still takes element colours after the atom was'
            + ' switched off');
    }
    v.setElementsFor([1], true);
    if (!v._segmentElementHalves({ idx1: 0, idx2: 1, origIndex: 0 })) {
        throw new Error('switching the ligand atom back on did nothing');
    }
});

t('an appended side-chain atom is not its own element owner', () => {
    // Appended atoms are type 'L' too and now carry an element in the array as
    // well as in the map. They belong to their residue, so the switch has to
    // stay per residue - one owner, not one per atom.
    const v = new Cls();
    v.positionTypes = ['P', 'L', 'L'];
    v.positionElements = ['', 'C', 'O'];
    v.sidechains = { pos: [0] };
    v.sidechainMap = new Map([[1, { owner: 0, el: 'C' }], [2, { owner: 0, el: 'O' }]]);
    const owners = v.elementOwners();
    if (!owners.has(0)) throw new Error('the owning residue is not an element owner');
    if (owners.has(1) || owners.has(2)) {
        throw new Error('a side-chain atom became its own element owner - its'
            + ' residue and its atoms would then switch separately');
    }
    if (v.elementOwners() !== owners) throw new Error('the owner set is rebuilt every call');
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
        sidechainRow: { hidden: null,
            querySelector: (sel) => (sel.indexOf('label') >= 0
                ? { textContent: '' } : { hidden: null }) },
        plateShowToggle: plateToggleNode(),
        sidechainShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
        elementsShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
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
        return nodes;
    };
    // A PROTEIN HAS ONE WAY OF BEING DRAWN, so Show is the whole question and
    // the style menu is not on the row at all - drawn or not.
    let n2 = run([1, 2], new Set([1, 2]));
    if (n2.plateShowToggle.label.hidden !== true || n2.sidechainShowToggle.checked !== true) {
        throw new Error('a protein with its side chains drawn reads wrong');
    }
    n2 = run([1, 2], new Set());
    if (n2.plateShowToggle.label.hidden !== true || n2.sidechainShowToggle.checked !== false) {
        throw new Error('a protein with nothing drawn reads wrong');
    }
    // A MIXED selection - one drawn, one not - is neither, so the SWITCH reads
    // indeterminate rather than picking a side and lying about half of it.
    n2 = run([1, 2], new Set([1]));
    if (n2.sidechainShowToggle.indeterminate !== true
        || n2.sidechainShowToggle.checked !== false) {
        throw new Error('a mixed selection did not read as mixed');
    }
    // ...and with nothing selected the controls read blank rather than stale
    n2 = run([], new Set([1, 2]));
    if (n2.plateShowToggle.checked !== false
        || n2.sidechainShowToggle.checked !== false) {
        throw new Error('an empty selection left a stale state');
    }
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
        sidechainRow: { hidden: null, basesRow: null,
            querySelector: (sel) => (sel.indexOf('label') >= 0
                ? { textContent: '' } : { hidden: null }) },
        basesRow: { hidden: null },
        elementsShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
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
        sidechainRow: { hidden: null, basesRow: null,
            querySelector: (sel) => (sel.indexOf('label') >= 0
                ? { textContent: '' } : { hidden: null }) },
        basesRow: { hidden: null },
        elementsShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
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
        sidechainRow: { hidden: null, basesRow: null,
            querySelector: (sel) => (sel.indexOf('label') >= 0
                ? { textContent: '' } : { hidden: null }) },
        basesRow: { hidden: null },
        elementsShowToggle: (() => {
            const label = { hidden: null };
            return { checked: false, indeterminate: false, hidden: null,
                closest: () => label, label };
        })(),
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
    // ...and the Plate switch, which is one of them and needs a name of its
    // own: three of these say only "Show" or one word, so the visible text
    // cannot be what announces them.
    const plate = html.match(/<input[^>]*id="plateShowToggle"[^>]*>/);
    if (!plate) throw new Error('no plateShowToggle');
    const plateName = (plate[0].match(/aria-label="([^"]+)"/) || [])[1];
    if (!plateName) throw new Error('the Plate switch has no aria-label');
    if (seen.has(plateName)) throw new Error('the Plate switch shares a name');
    // A LIST OF STYLES WITH "NOT DRAWN" IN IT is what this row stopped being:
    // Show says whether, Plate says which.
    if (/id="sidechainModeSelect"/.test(html)) {
        throw new Error('the three-way menu is back');
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



// SEVERAL OBJECTS AS ONE COORDINATE ARRAY (_mergeObjects).
//
// The overlay merges the frames of one object; this merges the current frame
// of several, and the whole point is that downstream cannot tell them apart -
// one array, one bond list, one map back to where each position came from.
// What can go wrong is entirely arithmetic: an unoffset bond index joins two
// structures that never touched, and a field that arrives short slides every
// position after it onto the wrong residue.
function mergeViewer() {
    const v = new Cls();
    v.objectsData = {
        A: {
            // bonds live on the OBJECT, which is where setCoords persists them
            // and where the frame load has always read them from
            bonds: [[1, 2]],
            frames: [{
                coords: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
                chains: ['A', 'A', 'A'],
                position_types: ['P', 'P', 'L'],
                position_names: ['ALA', 'GLY', 'HEM'],
                residue_numbers: [1, 2, 900],
                plddts: [10, 20, 30]
            }]
        },
        B: {
            // parked on its second frame, which is what a merge must take
            viewerState: { currentFrame: 1 },
            bonds: [[0, 1]],
            frames: [
                { coords: [[9, 9, 9]], chains: ['Z'] },
                {
                    coords: [[5, 0, 0], [6, 0, 0]],
                    chains: ['B', 'B'],
                    // ONE SHORT - the case that shifts everything after it.
                    // A field that is simply absent is easy; a field that is
                    // present and the wrong length is the one that slides
                    // every later position onto the wrong residue.
                    plddts: [70]
                }
            ]
        }
    };
    v.currentObjectName = 'A';
    v.currentFrame = 0;
    return v;
}

t('a merge concatenates the objects and maps each position back to its source', () => {
    const v = mergeViewer();
    const m = v._mergeObjects(['A', 'B']);
    eq(m.coords.length, 5, 'merged positions');
    eq(m.sourceNames.join(','), 'A,B', 'sources');
    eq(m.sourceIdMap.join(''), '00011', 'source of each position');
    eq(m.sourceOffsets.join(','), '0,3', 'where each source starts');
    // B is parked on frame 1, so its SECOND frame is the one merged
    eq(m.coords[3][0], 5, 'B contributed the frame it is parked on');
});

t('a merged bond can never join two objects', () => {
    const v = mergeViewer();
    const m = v._mergeObjects(['A', 'B']);
    eq(m.bonds.length, 2, 'bond count');
    eq(m.bonds[0].join('-'), '1-2', "A's bond is unmoved");
    eq(m.bonds[1].join('-'), '3-4', "B's bond is offset onto B's positions");
    for (const b of m.bonds) {
        if (m.sourceIdMap[b[0]] !== m.sourceIdMap[b[1]]) {
            throw new Error('a bond spans two objects: ' + b.join('-'));
        }
    }
});

t('a field missing from one object cannot shift the ones after it', () => {
    const v = mergeViewer();
    const m = v._mergeObjects(['A', 'B']);
    // B has no names, types or residue numbers at all, and a plddts array
    // one short of its coordinates
    for (const k of ['plddts', 'chains', 'position_types', 'position_names',
        'position_atoms', 'position_elements', 'residue_numbers']) {
        eq(m[k].length, 5, k + ' length');
    }
    // ...and A's own values are still against A's positions
    eq(m.position_names.slice(0, 3).join(','), 'ALA,GLY,HEM', 'A names');
    eq(m.residue_numbers[2], 900, "A's ligand residue number");
    eq(m.plddts.slice(0, 3).join(','), '10,20,30', 'A plddts');
    eq(m.chains.join(''), 'AAABB', 'chains');
});

t('PAE is dropped across objects and kept for one', () => {
    const v = mergeViewer();
    v.objectsData.A.frames[0].pae = [[0, 1], [1, 0]];
    eq(v._mergeObjects(['A']).pae !== null, true, 'one object keeps its PAE');
    eq(v._mergeObjects(['A']).autoColor, 'plddt', 'and colours by it');
    eq(v._mergeObjects(['A', 'B']).pae, null, 'two objects have no shared PAE');
});

t('merging one object is the same data as loading it alone', () => {
    const v = mergeViewer();
    const m = v._mergeObjects(['A']);
    eq(m.coords.length, 3, 'positions');
    eq(m.sourceIdMap.every((s) => s === 0), true, 'one source');
    eq(m.bonds[0].join('-'), '1-2', 'bonds unmoved');
    eq(m.autoColor, 'rainbow', 'single chain');
});

t('an empty or deleted object is skipped, not merged as a hole', () => {
    const v = mergeViewer();
    // one with no frames at all, and one with a frame holding no positions
    v.objectsData.C = { frames: [] };
    v.objectsData.D = { frames: [{ coords: [] }] };
    const m = v._mergeObjects(['A', 'gone', 'C', 'D', 'B']);
    eq(m.sourceNames.join(','), 'A,B', 'only the objects with positions');
    eq(m.sourceOffsets.join(','), '0,3', 'and no empty source in between');
    eq(m.coords.length, 5, 'positions');
    eq(v._mergeObjects(['gone']), null, 'nothing to merge');
});

// THE SIDE TABLES CARRY TWO DIFFERENT KINDS OF INDEX, and both have to move.
// `pos`/`frameOf` point at POSITIONS, `bonds`/`toBackbone` at ROWS of the table
// itself. Offset one and not the other and the second object grows its side
// chains on the first object's residues.
t('merged side tables offset positions and rows separately', () => {
    const v = mergeViewer();
    const table = (n) => ({
        pos: new Int32Array([0, 0]),
        frameOf: new Int32Array([0, 0]),
        coef: new Float32Array([1, 2, 3, 4, 5, 6]),
        bonds: new Int32Array([0, 1]),
        toBackbone: new Int32Array([0]),
        names: ['CB' + n, 'CG' + n],
        elements: ['C', 'C'],
        onBackbone: new Uint8Array([0, 0])
    });
    v.objectsData.A.frames[0].sidechains = table('a');
    v.objectsData.B.frames[1].sidechains = table('b');
    const sc = v._mergeObjects(['A', 'B']).sidechains;
    eq(sc.pos.length, 4, 'rows');
    eq(Array.from(sc.pos).join(','), '0,0,3,3', "B's rows point at B's positions");
    eq(Array.from(sc.frameOf).join(','), '0,0,3,3', 'frames likewise');
    eq(Array.from(sc.bonds).join(','), '0,1,2,3', "B's bond is between B's rows");
    eq(Array.from(sc.toBackbone).join(','), '0,2', 'to-backbone rows');
    eq(sc.names.join(','), 'CBa,CGa,CBb,CGb', 'names in order');
    eq(sc.coef.length, 12, 'coefficients');
    // one object at offset zero is handed through untouched
    delete v.objectsData.B.frames[1].sidechains;
    eq(v._mergeObjects(['A']).sidechains, v.objectsData.A.frames[0].sidechains,
        'a lone table is not rebuilt');
});


// WHICH POSITIONS MAY BE PART OF THE SAME THING (sourceGroups).
//
// One coordinate array can hold several structures - every frame of a
// trajectory, or several objects - and the rules that must not cross a source
// boundary (bonding, chain counting, shadowing) all read this one array. The
// case that bites is that SIDE CHAINS ARE APPENDED AFTER the merge: read raw,
// the map is short and every appended atom comes back undefined, which
// compares equal to every other undefined - so they become one phantom source,
// and each is severed from the residue it grows out of.
function grpViewer(n) {
    const v = new Cls();
    v.coords = new Array(n).fill(0);
    v.overlayState = { enabled: false, frameIdMap: null };
    v.multiState = { enabled: false, sourceIdMap: null };
    return v;
}

t('no merge means every position may reach any other', () => {
    eq(grpViewer(4).sourceGroups(), null, 'no groups');
});

t('the overlay and the object merge answer through one array', () => {
    const a = grpViewer(4);
    a.overlayState = { enabled: true, frameIdMap: [0, 0, 1, 1] };
    eq(a.sourceGroups().join(''), '0011', 'frames');
    const b = grpViewer(4);
    b.multiState = { enabled: true, sourceIdMap: [0, 1, 1, 1] };
    eq(b.sourceGroups().join(''), '0111', 'objects');
    // both set: the frames of ONE object, which is the merge that is loaded
    b.overlayState = { enabled: true, frameIdMap: [0, 0, 1, 1] };
    eq(b.sourceGroups().join(''), '0011', 'the overlay is the loaded merge');
});

t('an appended side-chain atom belongs to the source of its residue', () => {
    const v = grpViewer(6);
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 1, 1] };
    // two atoms appended, one grown from position 1 and one from position 3
    v.sidechainMap = new Map([[4, { owner: 1 }], [5, { owner: 3 }]]);
    const g = v.sourceGroups();
    eq(g.length, 6, 'one id per position');
    eq(g.join(','), '0,0,1,1,0,1', 'each atom took its residue\'s source');
    // ...and the same array is handed back rather than rebuilt per read
    eq(v.sourceGroups(), g, 'cached');
    // a rebuilt map is not the cached one
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 0, 1] };
    eq(v.sourceGroups().join(','), '0,0,0,1,0,1', 'rebuilt for a new merge');
});

t('an appended atom with no owner is its own source, never somebody else\'s', () => {
    const v = grpViewer(5);
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 1, 1] };
    v.sidechainMap = null;
    const g = v.sourceGroups();
    if (g[4] === 0 || g[4] === 1) {
        throw new Error('an unowned position was folded into a real source');
    }
});

t('a map longer than the array is refused', () => {
    const v = grpViewer(2);
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 1, 1] };
    eq(v.sourceGroups(), null, 'stale map');
});

// ...and the gates actually read it. Each of these used to test
// overlayState.frameIdMap directly, which is how the overlay came to sever
// side chains from their backbone and shade them as a source of their own.
t('nothing gates connectivity or shadows on the frame map directly', () => {
    const src2 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (src2.indexOf('\n        sourceGroups()') < 0) throw new Error('sourceGroups is gone');
    // the segment builder: where bonds and chain breaks are decided
    const at = src2.indexOf('// Generate Segment Definitions ONCE');
    const to = src2.indexOf('this.cachedSegmentIndices = this.segmentIndices.map', at);
    if (at < 0 || to < 0) throw new Error('cannot find the segment builder');
    if (/frameIdMap/.test(src2.slice(at, to))) {
        throw new Error('the segment builder reads frameIdMap instead of sourceGroups()');
    }
    const shadow = src2.slice(src2.indexOf('renderShadows && !skipShadowCalc'), 
        src2.indexOf('renderShadows && !skipShadowCalc') + 2600);
    if (/frameIdMap/.test(shadow)) {
        throw new Error('the shadow pass reads frameIdMap instead of sourceGroups()');
    }
    // ...and it does still ask. A merged view that shades every source
    // together is the mud the per-frame pass was written to avoid, and it is
    // also "do not cast shadow between objects" broken.
    if (!/const shadowGroups = this\.sourceGroups\(\);/.test(shadow)) {
        throw new Error('the shadow pass no longer groups by source');
    }
});

// SHOWING SEVERAL OBJECTS: what setShownObjects actually does.
//
// The single-object case must not go through the merge at all - it is the case
// that runs a thousand times a session, and a merge path it does not need is a
// merge path that can slow it down or quietly change it.
function shownViewer() {
    const v = mergeViewer();
    v.multiState = { enabled: false, sourceIdMap: null, sourceNames: null,
        sourceOffsets: null, autoColor: null };
    v.shownObjects = new Set();
    v.loaded = [];
    // ...and the coordinate array with it, because everything that translates
    // an index checks its length against the source map
    v._loadDataIntoRenderer = function (d) {
        this.loaded.push(d);
        this.coords = new Array(d.coords.length).fill(0);
    };
    v._loadFrameData = function (f) {
        this.loaded.push({ single: f });
        const o = this.objectsData[this.currentObjectName];
        const fr = o && o.frames && o.frames[Math.max(0, f | 0)];
        this.coords = new Array((fr && fr.coords.length) || 0).fill(0);
    };
    v._invalidateSegmentCache = function () { this.segCleared = true; };
    v._invalidateShadowCache = function () { this.shadowCleared = true; };
    v._exitOverlayMode = function () { this.exitedOverlay = true;
        this.overlayState.enabled = false; };
    v.clearResidueSelection = function () {
        this.selectionCleared = true; this.residueSelection = null;
    };
    v.setVisibility = function (patch) { this.mask = patch; };
    v.overlayState = { enabled: false, frameIdMap: null };
    v.viewerState = { zoom: 1, center: null, extent: null };
    return v;
}

t('showing one object never enters the merge', () => {
    const v = shownViewer();
    eq(v.setShownObjects(['A']), false, 'A was already the drawn object');
    eq(v.loaded.length, 0, 'nothing reloaded');
    eq(v.multiState.enabled, false, 'no merge');
});

t('showing two objects merges them and records where each starts', () => {
    const v = shownViewer();
    eq(v.setShownObjects(['A', 'B']), true, 'the picture changed');
    eq(v.multiState.enabled, true, 'merged');
    eq(v.multiState.sourceNames.join(','), 'A,B', 'sources');
    eq(v.multiState.sourceOffsets.join(','), '0,3', 'offsets');
    eq(v.loaded.length, 1, 'loaded once');
    eq(v.loaded[0].coords.length, 5, 'as one array');
    // EVERY OBJECT'S OWN VISIBILITY, expanded. Nobody has hidden anything, so
    // all five positions are visible - left as the current object's mask, the
    // second object is hidden entirely because the mask never mentions it.
    eq(v.mask.positions.size, 5, 'both objects are visible');
    eq(v.mask.visibilityMode, 'default', 'nothing is hidden, so nothing is explicit');
    eq(v.selectionCleared, true, 'the selection was made against the old array');
    eq(v.segCleared && v.shadowCleared, true, 'the caches for both were dropped');
    // THE CAMERA HAS TO FRAME THE LOT. Left on the current object, the second
    // one is simply out of shot - measured in the browser as two structures
    // correctly merged, mapped and coloured, with LESS ink than one alone.
    if (!v.viewerState.center) throw new Error('the view was not re-centred');
    if (!(v.viewerState.extent > 0)) throw new Error('the view extent still fits one object');
    const st = v.drawnStats();
    if (!st || !(st.maxExtent > 0) || st.totalPositions !== 5) {
        throw new Error('drawnStats does not describe the merge');
    }
});

t('an object that has something hidden keeps it hidden in the merge', () => {
    const v = shownViewer();
    // B has one of its two positions hidden; A has nothing hidden at all
    v.objectsData.B.visibilityState = { positions: new Set([1]), chains: new Set() };
    v.setShownObjects(['A', 'B']);
    eq(Array.from(v.mask.positions).sort((x, y) => x - y).join(','), '0,1,2,4',
        "A whole, and B's second position only");
    eq(v.mask.visibilityMode, 'explicit', 'something is hidden');
});

t('dropping back to one object leaves the merge behind', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    v.loaded = [];
    eq(v.setShownObjects(['A']), true, 'changed');
    eq(v.multiState.enabled, false, 'merge off');
    eq(v.multiState.sourceIdMap, null, 'and its map with it');
    eq(v.loaded.length, 1, 'reloaded');
    eq(v.loaded[0].single, 0, 'as a plain frame, not a merge');
});

t('a merge of objects and a merge of frames are never both on', () => {
    const v = shownViewer();
    v.overlayState = { enabled: true, frameIdMap: [0, 0, 0] };
    v.setShownObjects(['A', 'B']);
    eq(v.exitedOverlay, true, 'the overlay was left first');
    eq(v.multiState.enabled, true, 'and the object merge is on');
});

t('a name that is not loaded is ignored, never drawn as nothing', () => {
    const v = shownViewer();
    eq(v.setShownObjects(['nope']), false, 'no change');
    eq(v.drawnObjects().join(','), 'A', 'still the current object');
    // ...and it is not REMEMBERED either. Kept, it would lie in wait: load an
    // object under that name later and it appears on screen unasked, because
    // a list the user never edited already had it ticked.
    eq(v.shownObjects.has('nope'), false, 'the stale name was not kept');
});

t("each object's side chains are read at its own offset", () => {
    const v = shownViewer();
    v.objectsData.A.sidechains = new Set([1]);
    v.objectsData.B.sidechains = new Set([0]);
    eq(Array.from(v.shownSidechainSet()).join(','), '1', 'one object, no offset');
    v.setShownObjects(['A', 'B']);
    eq(Array.from(v.shownSidechainSet()).sort().join(','), '1,3',
        "B's residue 0 is merged position 3");
    eq(v.sourceOffsetOf('B'), 3, 'the offset itself');
    eq(v.sourceOffsetOf('A'), 0, 'the first object is not moved');
});

// ...and the colour. Two structures put side by side to compare come out
// identical under every other scheme - by chain both start at chain A, by
// rainbow both run blue to red - so a merged view colours by OBJECT.
t('a merged view gives each object a colour of its own', () => {
    // getAtomColor reaches a good deal of the module - the palette, the colour
    // hierarchy, the pLDDT ramps - so it is lifted with those supplied rather
    // than dragged in whole. The palette here is a stand-in on purpose: what
    // is being scored is which colour each position is sent to, not which
    // colours the palette holds.
    const src3 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const grab3 = (n) => {
        const i2 = src3.indexOf('\n        ' + n + '(');
        if (i2 < 0) throw new Error('cannot lift ' + n);
        let j = src3.indexOf('{', i2); let d = 0; let k = j;
        for (; k < src3.length; k++) {
            if (src3[k] === '{') d++; else if (src3[k] === '}' && !--d) break;
        }
        return src3.slice(i2, k + 1);
    };
    const C3 = new Function('resolveColorHierarchy', 'chainColors',
        'chainColorsColorblind', 'DEFAULT_GREY', 'getPlddtColor', 'getPlddtAFColor',
        'return class {' + grab3('getAtomColor') + grab3('sourceGroups')
        + ' _getEffectiveColorMode(){ return "object"; }'
        + ' _sidechainColorOf(){ return null; }'
        + ' _colorPositionFor(i){ return i; }'
        + ' getColorOverride(){ return null; }'
        + '}')(() => ({ resolvedMode: null, resolvedLiteralColor: null }),
            ['#ff0000', '#00ff00', '#0000ff'], ['#ff0000', '#00ff00', '#0000ff'],
            { r: 160, g: 160, b: 160 }, () => ({ r: 0, g: 0, b: 0 }),
            () => ({ r: 0, g: 0, b: 0 }));
    const v = new C3();
    v.coords = new Array(4).fill(0);
    v.chainColorKeyAt = (i) => 'A';
    v.objectsData = {}; v.currentObjectName = 'A';
    v.overlayState = { enabled: false, frameIdMap: null };
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 1, 1] };
    v.positionTypes = ['P', 'P', 'P', 'P'];
    v.chains = ['A', 'A', 'A', 'A'];
    v.plddts = [50, 50, 50, 50];
    const a = v.getAtomColor(0, 'object');
    const b = v.getAtomColor(3, 'object');
    if (a.r === b.r && a.g === b.g && a.b === b.b) {
        throw new Error('both objects came out the same colour');
    }
    eq(JSON.stringify(v.getAtomColor(1, 'object')), JSON.stringify(a),
        'one object is one colour');
    // a ligand is grey in every other mode; here it says which object it is on
    v.positionTypes = ['L', 'P', 'P', 'L'];
    if (JSON.stringify(v.getAtomColor(0, 'object')) === JSON.stringify(v.getAtomColor(3, 'object'))) {
        throw new Error('ligands were greyed and stopped saying which object');
    }
});

// READING AND WRITING A PER-OBJECT SET WHEN SEVERAL OBJECTS ARE MERGED.
//
// Everything an object remembers about its residues is keyed by position
// index, written against its own array: which show base plates, which show
// element colours, which are hidden, which were given a colour. Merged, only
// the first object still numbers from zero - so every one of those sets, read
// raw, lands on the first object's residues.
function xlateViewer() {
    const v = new Cls();
    v.coords = new Array(5).fill(0);
    v.positionTypes = ['D', 'D', 'D', 'P', 'P'];
    v.objectsData = { A: {}, B: {} };
    v.currentObjectName = 'A';
    v.overlayState = { enabled: false, frameIdMap: null };
    v.multiState = { enabled: true, sourceNames: ['A', 'B'],
        sourceOffsets: [0, 3], sourceFrames: [0, 2], sourceIdMap: [0, 0, 0, 1, 1] };
    return v;
}

t('a merged position knows which object it came from', () => {
    const v = xlateViewer();
    eq(v.ownerOf(0).name, 'A', 'first object');
    eq(v.ownerOf(4).name, 'B', 'second object');
    eq(v.ownerOf(4).local, 1, 'in its own numbering');
    eq(v.ownerOf(4).frame, 2, "and its own frame, not the viewer's");
    // a side-chain atom answers for the residue it grows out of: its own index
    // is past every source's range and means nothing to any object
    v.coords = new Array(6).fill(0);
    v.sidechainMap = new Map([[5, { owner: 4 }]]);
    v.multiState.sourceIdMap = [0, 0, 0, 1, 1];
    eq(v.ownerOf(5).name, 'B', 'the atom belongs to its residue');
    eq(v.ownerOf(5).local, 1, 'at the residue');
    // and with nothing merged there is nothing to translate
    v.multiState.enabled = false;
    eq(v.ownerOf(0), null, 'a lone object numbers from zero already');
});

t('a per-object set is read at that object\'s offset', () => {
    const v = xlateViewer();
    // B hides its second residue: local 1, merged 4
    v.objectsData.B.hiddenBackbone = new Set([1]);
    const hid = v.mergedObjectSet('hiddenBackbone', 'none');
    eq(Array.from(hid).join(','), '4', "B's own numbering, translated");
    // null means NONE for this one, so A contributes nothing
    if (hid.has(0) || hid.has(1)) throw new Error('A was hidden too');
});

t('null means all, and only when every object is untouched', () => {
    const v = xlateViewer();
    eq(v.mergedObjectSet('bases', 'all'), null, 'nobody has asked');
    // B hides one of its plates; A has never been touched, so A keeps ALL of
    // its own - if it contributed nothing, switching a plate off in one object
    // would hide every plate in the other.
    v.objectsData.B.bases = new Set([0]);
    const on = v.mergedObjectSet('bases', 'all');
    eq(Array.from(on).sort((a, b) => a - b).join(','), '0,1,2,3',
        'A entire, and the one B kept');
});

t('the merged set is cached until one of the sets behind it changes', () => {
    const v = xlateViewer();
    v.objectsData.A.bases = new Set([0]);
    const first = v.mergedObjectSet('bases', 'all');
    eq(v.mergedObjectSet('bases', 'all'), first, 'same answer, same object');
    // the GPU mesh signature compares this BY IDENTITY, so a new set every
    // read would rebuild the mesh every frame, and a stale one would never
    v.objectsData.A.bases = new Set([0, 1]);
    if (v.mergedObjectSet('bases', 'all') === first) {
        throw new Error('the cache outlived the set it was built from');
    }
});

t('a write lands on the object that owns the residue', () => {
    const v = xlateViewer();
    // merged 0 is A's residue 0; merged 4 is B's residue 1
    const groups = v.writeGroups([0, 4]);
    eq(groups.length, 2, 'two objects touched');
    const byName = {};
    for (const g of groups) byName[g.name] = g.positions.join(',');
    eq(byName.A, '0', "A's own index");
    eq(byName.B, '1', "B's own index");
});

t('hiding a base in the second object does not touch the first', () => {
    const v = xlateViewer();
    // merged 3 and 4 are B's residues, but only D/R positions take part
    v.positionTypes = ['D', 'D', 'D', 'D', 'D'];
    eq(v.setBasesFor([4], false), true, 'something changed');
    eq(v.objectsData.A.bases, undefined, 'A was not touched at all');
    const b = v.objectsData.B.bases;
    if (!(b instanceof Set)) throw new Error('B has no set');
    // B's set is materialised from B'S OWN nucleotides - two of them, 0 and 1 -
    // not from every nucleotide on screen
    eq(Array.from(b).sort().join(','), '0', 'B kept its first and lost its second');
});

t('a contact is resolved among its own object\'s positions', () => {
    const v = xlateViewer();
    v.chains = ['A', 'A', 'A', 'A', 'A'];
    v.residueNumbers = [1, 2, 3, 1, 2];
    // BOTH objects have a chain A with residues 1 and 2. Unwindowed, this
    // contact would resolve to the first object's residues whichever object
    // stored it.
    const c = ['A', 1, 'A', 2, 1.0];
    const inA = v._resolveContactToIndices(c, 5, v.localRangeOf('A'));
    const inB = v._resolveContactToIndices(c, 5, v.localRangeOf('B'));
    eq(inA.idx1 + ',' + inA.idx2, '0,1', 'A\'s own residues');
    eq(inB.idx1 + ',' + inB.idx2, '3,4', 'B\'s own residues');
    // ...and an index-pair contact is in its object's numbering too
    const d = v._resolveContactToIndices([0, 1, 1.0], 5, v.localRangeOf('B'));
    eq(d.idx1 + ',' + d.idx2, '3,4', 'offset onto B');
});

t('a merged bond list is never written back onto an object', () => {
    // setCoords persists bonds onto the current object so the next frame can
    // reuse them. A MERGED list is offsets into an array of several objects,
    // and stored there it outlives the merge: the next plain load reads it
    // back and bonds that object's residues to positions that are gone.
    const src4 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = src4.indexOf('        setCoords(');
    const body = src4.slice(at, at + 2000);
    const m = body.match(/objectsData\[this\.currentObjectName\]\.bonds = bonds/);
    if (!m) throw new Error('setCoords no longer persists bonds at all');
    const before = body.slice(0, body.indexOf(m[0]));
    if (!/multiState && this\.multiState\.enabled/.test(before)) {
        throw new Error('a merged bond list can still be written onto an object');
    }
});

// EACH OBJECT KEEPS ITS OWN COLOUR SCHEME.
//
// A flat colour per object reads well for two copies of one protein and badly
// for everything else: a dimer beside a monomer should look like a dimer and a
// monomer, which is what each looks like on its own. So 'auto' is resolved per
// SOURCE, from that source's own chains and its own PAE.
t('a merge resolves auto colour per object, from that object\'s own data', () => {
    const v = mergeViewer();
    // A has one chain, B has two
    v.objectsData.B.frames[1].chains = ['B', 'C'];
    const m = v._mergeObjects(['A', 'B']);
    eq(m.sourceAutoColors.join(','), 'rainbow,chain',
        'a monomer rainbows, a two-chain object colours by chain');
    // ...and a predicted model by confidence, whichever object it is
    v.objectsData.B.frames[1].pae = [[0, 1], [1, 0]];
    eq(v._mergeObjects(['A', 'B']).sourceAutoColors.join(','), 'rainbow,plddt',
        'PAE wins for the object that has it');
});

t('a position resolves auto to its own object\'s answer', () => {
    const v = new Cls();
    v.coords = new Array(5).fill(0);
    v.overlayState = { enabled: false, frameIdMap: null };
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 0, 1, 1],
        sourceNames: ['A', 'B'], sourceOffsets: [0, 3],
        sourceAutoColors: ['rainbow', 'chain'] };
    v.resolvedAutoColor = 'object';
    eq(v._autoColorFor(0), 'rainbow', "the first object's answer");
    eq(v._autoColorFor(4), 'chain', "the second object's answer");
    // without a position there is no per-object answer to give
    eq(v._autoColorFor(undefined), 'object', 'the merge as a whole');
});

// ...and the chain scheme has to stay legible across the join. Chain ids are
// unique inside a file and nowhere else: both structures have a chain A.
t('the same chain id in two objects is not the same colour', () => {
    const v = new Cls();
    v.coords = new Array(4).fill(0);
    v.chains = ['A', 'A', 'A', 'A'];
    v.overlayState = { enabled: false, frameIdMap: null };
    v.multiState = { enabled: true, sourceIdMap: [0, 0, 1, 1],
        sourceNames: ['A', 'B'], sourceOffsets: [0, 2] };
    v._chainColorKeys = v.chains.map((c, i) => v.multiState.sourceIdMap[i] + '|' + c);
    if (v.chainColorKeyAt(0) === v.chainColorKeyAt(3)) {
        throw new Error('both objects\' chain A share a colour key');
    }
    eq(v.chainColorKeyFor('A', 'B'), '1|A', 'and a chain can be keyed by name');
    // with nothing merged the key IS the chain id, so nothing changes today
    v.multiState.enabled = false;
    v._chainColorKeys = null;
    eq(v.chainColorKeyAt(0), 'A', 'a lone object keys by chain alone');
    eq(v.chainColorKeyFor('A', 'B'), 'A', 'and so does the lookup');
});

// STRUCTURAL EDITS RUN ON ONE OBJECT. Copy, Cut and Delete rewrite an object's
// frames and renumber everything keyed to them, all of it written against that
// object's own array - so the merge is put down for the duration.
t('an edit sees its object alone, with the selection in that object\'s numbering', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    // a selection spanning both objects: A's residue 1, B's residue 1
    v.residueSelection = new Set([1, 4]);
    v.visibilityModel = { positions: new Set([0, 1, 2, 3, 4]), chains: new Set() };
    v.currentObjectName = 'B';
    let sawMerge = null;
    let sawSel = null;
    const out = v._editOneObject(() => {
        sawMerge = v.multiState.enabled;
        sawSel = Array.from(v.residueSelection).join(',');
        return 'done';
    });
    eq(out, 'done', 'the edit ran');
    eq(sawMerge, false, 'with the merge down');
    eq(sawSel, '1', "and only B's own residue, in B's numbering");
    eq(v.multiState.enabled, true, 'and the merge is picked back up');
    eq(v.multiState.sourceNames.join(','), 'A,B', 'with the same objects');
});

t('an object made by an edit ends up on screen', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    v.residueSelection = new Set([0]);
    v.visibilityModel = { positions: new Set(), chains: new Set() };
    v._editOneObject(() => {
        // what Copy does: makes an object and switches to it
        v.objectsData.C = { frames: [{ coords: [[0, 0, 0]], chains: ['A'] }] };
        v.currentObjectName = 'C';
    });
    // a copy that lands off screen looks like a copy that never happened
    eq(v.drawnObjects().join(','), 'A,B,C', 'the new object is drawn too');
});

t('the selection of one object is not the selection of another', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    v.residueSelection = new Set([0, 1, 3]);
    eq(Array.from(v.selectionForObject('A')).join(','), '0,1', "A's share");
    eq(Array.from(v.selectionForObject('B')).join(','), '0', "B's share, renumbered");
    v.residueSelection = new Set([0]);
    eq(v.selectionForObject('B'), null, 'nothing of B was selected');
});

// THE PANEL RELOADS WHAT IS DRAWN, NEVER "THE FRAME".
//
// Side chains, bases, contacts and the cyclic toggle all change the coordinate
// array rather than its colours, so each reloads after writing. Reloading the
// FRAME rebuilds the current object alone - which with several objects merged
// throws the rest of them off the screen, and reads as the toggle deleting
// them.
t('nothing in the app reloads a single frame behind the merge\'s back', () => {
    const app = fs.readFileSync('web/app.js', 'utf8');
    const hits = app.split('\n')
        .map((l, k) => [k + 1, l])
        .filter(([, l]) => /_loadFrameData\s*\(/.test(l) && !/reloadDrawn/.test(l));
    if (hits.length) {
        throw new Error('app.js calls _loadFrameData directly at line(s) '
            + hits.map(([k]) => k).join(', ')
            + ' - use reloadDrawn, which keeps a multi-object view together');
    }
    // ...and reloadDrawn actually knows about the merge
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('        reloadDrawn(');
    if (at < 0) throw new Error('reloadDrawn is gone');
    const body = mol.slice(at, mol.indexOf('\n        }', at));
    if (!/multiState[\s\S]*_applyShownObjects/.test(body)) {
        throw new Error('reloadDrawn no longer rebuilds the merge');
    }
});

// ...AND THE OVERLAY IS NOT AN OBJECT MERGE. It puts every frame of ONE object
// in the array, so chain A is the same chain A in all of them; keyed per source
// the same chain would come out a different colour in every frame, which is not
// what the overlay has ever looked like.
t('the overlay does not get one chain colour per frame', () => {
    const src5 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = src5.indexOf('this._chainColorKeys = grp');
    if (at < 0) throw new Error('the chain colour keys are gone');
    const before = src5.slice(at - 500, at);
    if (!/multiState[\s\S]*enabled/.test(before)) {
        throw new Error('the chain colour key is built for any merge, so the'
            + ' overlay would colour one chain differently in every frame');
    }
});

// THE OVERLAY BUTTON SAYS WHETHER OVERLAY IS ON, whoever turned it off.
// Showing several objects puts the overlay down on its way in, and the button
// used to be styled only by the toggle that could no longer be the only way
// the state moved - leaving it lit over a view that was not overlaid, so the
// next press would turn overlay ON while reading as off.
t('the overlay button follows the state, not just the button', () => {
    const src6 = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    if (!/_syncOverlayButton\(\) \{/.test(src6)) {
        throw new Error('the overlay button styling is not shared');
    }
    for (const fn of ['_enterOverlayMode', '_exitOverlayMode']) {
        const at = src6.indexOf('        ' + fn + '(');
        if (at < 0) throw new Error(fn + ' is gone');
        const body = src6.slice(at, src6.indexOf('\n        }\n', at));
        if (!/_syncOverlayButton\(\)/.test(body)) {
            throw new Error(fn + ' changes the overlay state without telling the button');
        }
    }
});

// A MERGE IS REBUILT FOR REASONS THAT ARE NOT A CHANGE OF OBJECTS - a frame
// step, a side chain, a contact - and those must not undo what the user did.
t('rebuilding the merge keeps what was hidden and what was selected', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    // B becomes the current object, on the frame it was parked on
    v.currentObjectName = 'B';
    v.currentFrame = 1;
    // hide the last position and select another, both in merged indices
    v.visibilityModel = { positions: new Set([0, 1, 2, 3]), chains: new Set(),
        visibilityMode: 'explicit' };
    v.residueSelection = new Set([4]);
    v.setVisibility = function (patch) { this.mask = patch; };

    // the same objects again: what a frame step does
    // ...and a pan the user made since the merge began
    v.viewerState.center = { x: 7, y: 8, z: 9 };
    v.viewerState.extent = 42;
    v._applyShownObjects();
    eq(Array.from(v.mask.positions).sort((a, b) => a - b).join(','), '0,1,2,3',
        'the hidden position stayed hidden');
    eq(v.viewerState.center.x, 7, 'the view was not re-framed under the user');
    eq(v.viewerState.extent, 42, 'nor re-zoomed');
    eq(v.residueSelection ? Array.from(v.residueSelection).join(',') : 'null', '4',
        'and the selection survived a rebuild that changed no objects');

    // ...whereas changing the objects does drop the selection, which was made
    // against an array that no longer exists
    v.setShownObjects(['A']);
    eq(v.selectionCleared, true, 'a different set of objects clears it');
});

t('a hidden residue of the second object is not read as the first object\'s', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    v.currentObjectName = 'B';
    v.currentFrame = 1;
    // B is positions 3 and 4; hide 4, so the live mask is {0,1,2,3}
    v.visibilityModel = { positions: new Set([0, 1, 2, 3]), chains: new Set() };
    v._applyShownObjects();
    // Read as B's OWN numbering, the live mask {0,1,2,3} says B's residues 0
    // and 1 are both visible - so the position the user hid comes back.
    if (!v.mask.positions.has(3)) {
        throw new Error("B's visible position was hidden");
    }
    if (v.mask.positions.has(4)) {
        throw new Error('the hidden position came back - the live mask was read'
            + " as if it were in B's own numbering");
    }
    // ...and A, which nobody touched, is whole
    for (const i of [0, 1, 2]) {
        if (!v.mask.positions.has(i)) throw new Error('A lost position ' + i);
    }
});

t('an object loaded while several are shown joins them', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    v.objectsData.C = { frames: [] };
    v.addObject = Cls.prototype.addObject;
    // just the first lines of addObject matter here: the rest wants a DOM
    try { v.addObject('C'); } catch (e) { /* the UI half is not lifted */ }
    if (!v.shownObjects.has('C')) {
        throw new Error('a newly loaded object is invisible while others are shown');
    }
    // ...but a single-object session keeps its empty set, which is what makes
    // "just the current one" the default
    const w = shownViewer();
    try { w.addObject = Cls.prototype.addObject; w.addObject('C'); } catch (e) { /* as above */ }
    eq(w.shownObjects.size, 0, 'nothing was written down for a lone object');
});

// PLAYBACK MUST NOT DROP THE OTHER OBJECTS.
//
// Five paths move to a frame outside setFrame - the animation timer, the loop
// back to frame 0, the recorder, the render loop's catch-up and the capture
// sweep - and every one of them tested the OVERLAY alone before loading. With
// several objects merged, loading "the frame" rebuilds the current object by
// itself, so pressing play dropped the other structures on the first tick.
t('every playback path loads through the one rule', () => {
    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    const at = mol.indexOf('        _loadFrameForPlayback(');
    if (at < 0) throw new Error('_loadFrameForPlayback is gone');
    const body = mol.slice(at, mol.indexOf('\n        }', at));
    if (!/overlayState[\s\S]*multiState[\s\S]*_applyShownObjects/.test(body)) {
        throw new Error('the playback rule no longer covers both merges');
    }
    // ...and nothing near an animation still tests the overlay on its own
    const suspects = mol.split('\n').map((l, k) => [k + 1, l])
        .filter(([, l]) => /_loadFrameData\(/.test(l));
    for (const [line, text] of suspects) {
        const around = mol.split('\n').slice(Math.max(0, line - 6), line).join(' ');
        // ...the rule's own body excepted, which is where that test belongs
        if (/overlayState\.enabled/.test(around)
            && !/_loadFrameForPlayback\(/.test(around)
            && !/multiState[\s\S]*_applyShownObjects/.test(around)) {
            throw new Error('line ' + line + ' guards a frame load on the overlay'
                + ' alone - a multi-object view would lose everything but the'
                + ' current object');
        }
    }
});

// A MERGE OF BIG STRUCTURES MUST NOT BLOW THE STACK.
//
// `out.push(...src)` passes every element as an argument: measured here, a
// hundred thousand is fine and a hundred and twenty-five thousand throws. Both
// merges concatenate whole per-position arrays, and both are reachable with
// structures that size - a capsid overlaid on itself, or two of them shown at
// once - where the failure is a RangeError in the middle of a load.
t('the merges do not spread whole arrays into push', () => {
    const cap = 125000;
    const big = new Array(cap).fill(1);
    let spreadThrows = false;
    try { const o = []; o.push(...big); } catch (e) { spreadThrows = true; }
    if (!spreadThrows) throw new Error('this engine spreads ' + cap
        + ' arguments - pick a bigger array for this test');

    const mol = fs.readFileSync('py2Dmol/resources/viewer-mol.js', 'utf8');
    for (const fn of ['_mergeFrameRange', '_mergeObjects']) {
        const at = mol.indexOf('        ' + fn + '(');
        if (at < 0) throw new Error(fn + ' is gone');
        // ...code only: the comment above each fix names the pattern it
        // replaced, and a grep that cannot tell the two apart would fail on
        // the explanation for why it passes.
        const body = mol.slice(at, mol.indexOf('\n        }\n', at))
            .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        const bad = body.match(/push\(\.\.\.[a-zA-Z]/g);
        if (bad) throw new Error(fn + ' spreads an array into push (' + bad.length
            + ' place(s)) - a structure over about 100k positions throws');
    }
});

t('Hide all survives a rebuild - an empty mask is an answer', () => {
    const v = shownViewer();
    v.setShownObjects(['A', 'B']);
    v.currentFrame = 1;
    // what Hide all leaves: a mask that names nothing, in explicit mode
    v.visibilityModel = { positions: new Set(), chains: new Set(),
        visibilityMode: 'explicit' };
    v._applyShownObjects();
    eq(v.mask.positions.size, 0,
        'everything came back on screen - an empty mask was read as "nobody has'
        + ' said anything" rather than as "nothing is visible"');
    eq(v.mask.visibilityMode, 'explicit', 'and it is explicit, not default');
});

console.log(fail ? ('FAILURES '+fail):'all '+pass+' checks passed');
process.exit(fail?1:0);
