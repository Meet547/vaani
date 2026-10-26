import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadPolicy,validatePolicy,metrics,assignTier,retentionOptions,businessDeadline} from '../lib/policy.mjs';
import {words} from '../lib/words.mjs';
const p=loadPolicy({customerSource:'fixtures'});
test('the documented heroes produce exactly B, D, X and C with the expected spend',()=>{
  assert.deepEqual(p.customers.map(c=>assignTier(c,metrics(c,p),p)),['B','D','X','C']);
  assert.deepEqual(p.customers.map(c=>metrics(c,p).annual_spend_12m),[256000,8000,480000,108000]);
});
test('offer amounts never exceed actual fee, global cap, or tier cap across a matrix',()=>{
  for(const fee of [0,1,1499,2999,3000,9000])for(const spend of [0,8000,30000,120000,300000,400000])for(const score of [600,700,750]){
    const c={...p.customers[0],annual_fee:fee,monthly_spend:Array(12).fill(spend/12)};
    c.score=score;const result=retentionOptions(c,'competitor',p);
    for(const o of result.options){
      if(o.amount!==undefined)assert.ok(o.amount<=Math.min(fee,p.card.waiver_cap));
      if(o.points!==undefined)assert.ok(o.points<=Math.min(p.tiers.limits[result.tier].points,p.card.points_cap));
      if(result.tier==='X'||result.tier==='D')assert.equal(o.id,'CARD_DOWNGRADE_FREE');
    }
  }
});
test('waiver history, fee ratio, consent and inactive/fraud gates are applied',()=>{
  const c=structuredClone(p.customers[0]);c.prior_waiver_days_ago=10;
  assert.ok(!retentionOptions(c,'fee',p).options.some(o=>/WAIVER|REVERSAL|MATCH/.test(o.id)));
  c.prior_waiver_days_ago=null;c.bureau_consent=false;c.score=100;c.dpd_90_count=10;
  assert.equal(assignTier(c,metrics(c,p),p),'B');
  assert.ok(!retentionOptions(c,'competitor',p).options.some(o=>o.id==='CARD_COMPETITOR_MATCH'));
  c.fraud_ticket=true;assert.equal(retentionOptions(c,'fee',p).options.length,0);
  c.fraud_ticket=false;c.status='blocked';assert.equal(retentionOptions(c,'fee',p).options.length,0);
  c.status='active';c.monthly_spend=Array(12).fill(2500);c.annual_fee=2999;
  assert.ok(!retentionOptions(c,'fee',p).options.some(o=>o.id==='CARD_FEE_WAIVER_COND'));
});
test('business deadline skips weekends and configured holidays using India dates',()=>{
  assert.equal(businessDeadline(new Date('2026-10-23T10:00:00Z'),1,p.closure),'2026-10-26');
  assert.equal(businessDeadline(new Date('2026-10-23T20:00:00Z'),1,{...p.closure,holidays:['2026-10-26']}),'2026-10-27');
});
test('invalid/unsafe policy fails closed and monetary speech is deterministic',()=>{
  const unsafe=structuredClone(p);unsafe.card.max_offers=2;assert.throws(()=>validatePolicy(unsafe));
  unsafe.card.max_offers=1;unsafe.card.approved_for_live_use=true;assert.throws(()=>validatePolicy(unsafe));
  assert.equal(words(2999),'two thousand nine hundred ninety nine');assert.equal(words(12500),'twelve thousand five hundred');
  assert.throws(()=>words(NaN));assert.throws(()=>words(-1));assert.throws(()=>words(0.7));
});
