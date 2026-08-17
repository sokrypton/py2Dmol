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
const names=['_inertiaAllowed','_frameOverBudget','smoothAnimationOk','_scheduleSettle'];
const body={};
for(const nm of names){
 const i=src.indexOf('\n        '+nm+'(');
 if(i<0) throw new Error('method not found: '+nm);
 // brace-match from the opening {
 let j=src.indexOf('{',i), d=0, k=j;
 for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
 body[nm]=src.slice(i,k+1);
}
const Cls=new Function('document','return class V {'+names.map(n=>body[n]).join('\n')+'}')
 ({createElement:()=>mkCanvas(0,0)});
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
console.log(fail ? ('FAILURES '+fail):'all '+pass+' checks passed');
process.exit(fail?1:0);
