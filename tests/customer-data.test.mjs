import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadCustomerData,parseCsv,datasetPath} from '../lib/customer-data.mjs';
import {loadPolicy,metrics,assignTier,retentionOptions} from '../lib/policy.mjs';
import {CardEngine} from '../lib/engine.mjs';
import {Store} from '../lib/store.mjs';
const csv=readFileSync(datasetPath,'utf8'),p=loadPolicy();

test('CSV parser preserves quoted commas, newlines, BOM and escaped quotes; rejects malformed input',()=>{
  assert.deepEqual(parseCsv('\uFEFFid,note\r\n1,"a,b\n""quoted"""\r\n').rows,[{id:'1',note:'a,b\n"quoted"'}]);
  for(const text of ['a,a\n1,2','a,b\n1','a,b\n1,"open','a,b\n1,"quote"x'])assert.throws(()=>parseCsv(text));
});
test('all 250 records import, with 160 card profiles, 110 gold profiles and explicit data review gates',()=>{
  assert.equal(p.catalog.length,250);assert.equal(new Set(p.catalog.map(c=>c.id)).size,250);
  assert.deepEqual(p.dataset.segments,{card_only:140,gold_only:90,card_and_gold:20});
  assert.equal(p.dataset.cardProfiles,160);assert.equal(p.dataset.goldProfiles,110);assert.equal(p.dataset.cardReady,148);assert.equal(p.dataset.cardNeedsReview,12);
  assert.equal(p.catalog.filter(c=>c.blockingReasons.some(s=>s.includes('EMI outstanding exceeds'))).length,10);
  assert.equal(p.catalog.find(c=>c.id==='C0058').card.dues,0);assert.equal(p.catalog.find(c=>c.id==='C0058').card.emi,6500);
});
test('CSV hero facts replace placeholder facts; raw spend series and flags drive policy',()=>{
  const c=id=>p.customers.find(c=>c.id===id);
  assert.equal(c('H-CARD-1').name,'Riya Deshmukh');assert.equal(c('H-CARD-1').product,'Rewards');
  assert.equal(metrics(c('H-CARD-3'),p).annual_spend_12m,720000);assert.equal(assignTier(c('H-CARD-3'),metrics(c('H-CARD-3'),p),p),'X');
  assert.equal(c('H-CARD-2').dnd,false);assert.equal(c('H-CARD-2').reward_points,310);
  assert.equal(c('H-CARD-4').reward_points,2000);assert.equal(c('H-CARD-4').annual_fee,2999);
  assert.equal(metrics(c('H-CARD-1'),p).fee_charged_recently,false);
  assert.ok(!retentionOptions(c('H-CARD-1'),'fee',p).options.some(o=>o.id==='CARD_FEE_REVERSAL'));
  for(const customer of p.customers.filter(c=>c.product==='LifetimeFree'))assert.equal(customer.fee_waiver_spend,0);
});
test('expected outcomes, source confirmation confidence, and gold columns cannot control card policy',()=>{
  const altered=csv.replaceAll('CARD_FEE_WAIVER_COND','UNAUTHORIZED_999999').replaceAll('GOLD_RATE_EXCEPTION','APPROVE_EVERYTHING');
  const data=loadCustomerData(altered);
  // Only provenance changes when expected-output cells change.
  assert.deepEqual(data.customers.map(({source_revision,...c})=>c),p.customers.map(({source_revision,...c})=>c));
  assert.ok(!JSON.stringify(p.customers).includes('EXP_'));assert.ok(!JSON.stringify(p.catalog).includes('EXP_'));
  assert.ok(!JSON.stringify(p.customers).includes('voice_stt_confidence_on_confirm'));
  for(const c of p.customers.filter(c=>!c.bureau_consent)){assert.equal(c.score,null);assert.equal(c.dpd_90_count,0);}
});
test('every actionable imported customer obeys caps and can finish an explicit closure or fraud handoff',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,p);const originalCustomers=structuredClone(p.customers);
  for(const c of p.customers){
    for(const reason of ['fee','competitor','low_rewards','not_using']){
      for(const o of retentionOptions(c,reason,p).options){if(o.amount!==undefined)assert.ok(o.amount<=Math.min(c.annual_fee,p.card.waiver_cap));if(o.points!==undefined)assert.ok(o.points<=p.card.points_cap);}
    }
    let result=engine.create({customerId:c.id});const id=result.session.id;
    if(c.fraud_ticket){assert.equal(result.session.state,'HANDOFF');assert.equal(result.session.offerCount,0);continue;}
    result=engine.handle(id,{text:'Just close my card. No offers.'});
    if(result.session.closureStep==='points')result=engine.handle(id,{action:'skip'});
    assert.equal(result.session.closureStep,'confirm',c.id);
    result=engine.handle(id,{action:'confirm_closure',token:result.session.confirmationToken});
    assert.equal(result.session.state,'CLOSED',c.id);assert.equal(result.session.closure.status,c.outstanding_dues?'pending_dues':'submitted');
    assert.equal(result.session.offerCount,0);
  }
  assert.deepEqual(p.customers,originalCustomers);
});
test('gold-only, conflicting balances and inactive cards cannot create sessions even through direct engine calls',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,p);
  for(const c of p.catalog.filter(c=>!c.canStartCard))assert.throws(()=>engine.create({customerId:c.id}),/Gold-only|EMI outstanding|Card status/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
});
test('CSV DND/contact gates, current facts and snapshot persistence remain independent of expected labels',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,p);
  for(const c of p.customers.filter(c=>c.dnd||!c.outreach_consent||(c.last_contact_days_ago!==null&&c.last_contact_days_ago<7))){
    const r=engine.create({customerId:c.id,trigger:'usage_drop'});assert.equal(r.session.state,'BLOCKED');assert.ok(!r.session.trace.some(e=>e.kind==='SERVICE'));
  }
  const r=engine.create({customerId:'H-CARD-4'});let next=engine.handle(r.session.id,{text:'just close it'});
  assert.equal(next.session.checklist.points,2000);assert.equal(next.session.checklist.dues,12500);assert.equal(next.session.checklist.emi,4000);
  next=engine.handle(r.session.id,{action:'skip'});assert.equal(next.session.closureStep,'confirm');
  const resumed=new CardEngine(store,p).resume(r.session.id);assert.equal(resumed.customer.sourceRevision,p.dataset.revision);assert.equal(resumed.closureStep,'confirm');
  assert.ok(resumed.trace.some(e=>e.kind==='DATASET'));
});
test('CSV acceptance changes only the session snapshot, and marks waiver history for subsequent eligibility',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,p);
  const r=engine.create({customerId:'H-CARD-1'});engine.handle(r.session.id,{text:'the annual fee is too high'});engine.handle(r.session.id,{action:'accept_offer'});
  const saved=store.get(r.session.id);assert.equal(metrics(saved.customer,p).prior_waiver_12m,true);
  assert.equal(metrics(p.customers.find(c=>c.id==='H-CARD-1'),p).prior_waiver_12m,false);
});
test('duplicate IDs and missing required columns fail the import instead of using partial data',()=>{
  assert.throws(()=>loadCustomerData(csv.replace('H-CARD-2','H-CARD-1')),/duplicate customer/);
  assert.throws(()=>loadCustomerData(csv.replace('consent_service','missing_service')),/missing consent_service/);
});
