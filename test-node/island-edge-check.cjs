'use strict';
const assert = require('node:assert/strict');
const I = require('../frontend/island-interaction.js');
const facts = extra => ({state:'compact',view:'overview',settled:true,nativeReady:true,
  ...Object.fromEntries(I.BLOCKERS.map(k=>[k,false])),notice:false,pinned:false,...extra});
const mouse = {isTrusted:true,pointerType:'mouse',buttons:0};
function fixture() {
  let now=0, id=0; const jobs=new Map(), changes=[];
  const c=I.createEdgeController({now:()=>now,schedule:(fn,ms)=>{const n=++id;jobs.set(n,{fn,at:now+ms});return n;},cancel:n=>jobs.delete(n),onHidden:v=>changes.push(v)});
  const advance=ms=>{const end=now+ms;for(;;){const next=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();}now=end;};
  return {c,jobs,changes,advance,early(){const [id,job]=[...jobs][0];jobs.delete(id);job.fn();}};
}
const f=fixture(); f.c.update(facts()); f.advance(179999); assert.equal(f.c.snapshot().hidden,false);
f.advance(1); assert.equal(f.c.snapshot().hidden,true,'default three-minute idle hides');
f.c.enter(mouse); assert.equal(f.c.snapshot().hidden,false,'pointer wakes immediately');
f.advance(600000); assert.equal(f.c.snapshot().hidden,false,'never hide under pointer');
f.c.leave(mouse); f.c.setPreferences({sound:false,absenceMinutes:3}); f.advance(999); assert.equal(f.c.snapshot().hidden,false);
f.advance(1); assert.equal(f.c.snapshot().hidden,true,'muted compact hides after one second outside');
f.c.alert(); assert.equal(f.c.snapshot().hidden,false,'alert wakes');
for(const block of [...I.BLOCKERS,'notice','pinned']) {
  const p=fixture();p.c.setPreferences({sound:false,absenceMinutes:1});p.c.update(facts());p.advance(1000);
  p.c.update(facts({[block]:true})); assert.equal(p.c.snapshot().hidden,false,block+' reveals');
  p.advance(600000);assert.equal(p.c.snapshot().hidden,false,block+' prevents hiding');
}
for(const state of ['expanded','hidden','unknown']) {const p=fixture();p.c.update(facts({state}));p.advance(600000);assert.equal(p.c.snapshot().hidden,false,state);}
const lostLeave=fixture(); lostLeave.c.setPreferences({sound:false,absenceMinutes:1}); lostLeave.c.update(facts()); lostLeave.c.enter(mouse); lostLeave.c.update(facts({pointerInside:false})); lostLeave.advance(1000); assert.equal(lostLeave.c.snapshot().hidden,true,'live hover readback clears stale inside after native remapping');
const early=fixture(); early.c.setPreferences({sound:false,absenceMinutes:1}); early.c.update(facts()); early.advance(999); early.early(); early.advance(1); assert.equal(early.c.snapshot().hidden,true,'early WebKit timer delivery retries only the remaining millisecond');
const p=fixture();p.c.setPreferences({sound:true,absenceMinutes:1});p.c.update(facts());p.advance(30000);p.c.update(facts());p.advance(30000);assert.equal(p.c.snapshot().hidden,true,'snapshot churn cannot postpone absence');
p.c.stop();const before=p.changes.length;p.advance(600000);assert.equal(p.changes.length,before);
console.log('PASS island-edge: absence, mute, pointer/alert wake, pending protections and teardown');
