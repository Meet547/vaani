import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CardEngine} from '../lib/engine.mjs';
import {Store} from '../lib/store.mjs';
import {loadPolicy} from '../lib/policy.mjs';
import {classify} from '../lib/intents.mjs';
import {classifierContext} from '../lib/dialogue.mjs';

function setup(t,customerId='H-CARD-4'){
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,loadPolicy()),created=engine.create({customerId});
  return {store,engine,id:created.session.id,send:(text,input={})=>engine.handle(created.session.id,{text,...input})};
}
test('the reported Hinglish redemption and follow-up questions progress exactly once without submitting closure',t=>{
  const x=setup(t);x.send('Just close my card');let r=x.send('mere kitne points hai');assert.match(r.reply.text,/two thousand/);assert.equal(r.session.closureStep,'points');
  r=x.send('haa kardo fir redeem',{channel:'voice',confidence:null});assert.equal(r.session.closureStep,'confirm');assert.equal(r.session.language,'hi-IN');assert.equal(r.session.checklist.points,0);assert.equal(r.session.state,'CLOSURE_FLOW');
  assert.ok(!r.session.closure);r=x.send('haan redeem kar do');assert.equal(r.session.closureStep,'confirm');assert.ok(!r.session.closure);
  assert.equal(x.store.trace(x.id).filter(e=>e.kind==='SERVICE'&&e.detail.name==='redeem_points').length,1);
  r=x.send('What are my outstanding dues?');assert.match(r.reply.text,/twelve thousand five hundred/);assert.equal(r.session.closureStep,'confirm');
});
test('natural English, Hindi and Hinglish redemption variants bind only to points',t=>{
  for(const text of ['haa kardo fir redeem','haan points redeem kar do','points redeem kardo','yes please redeem them','please redeem my points','हाँ कर दो फिर रिडीम','हाँ पॉइंट्स रिडीम कर दीजिए','haan kar do','ha kar do','haan ridim kardo']){
    const x=setup(t);x.send('Just close my card');const r=x.send(text);assert.equal(r.session.closureStep,'confirm',text);assert.equal(r.session.checklist.points,0,text);assert.ok(!r.session.closure,text);
  }
});
test('negatives, hypothetical, conditional and partial redemption requests never redeem silently',t=>{
  for(const text of ['how do I redeem?','agar redeem karu to kya hoga','redeem only 500 points','redeem if I get cash','redeem them tomorrow','What are these points worth?']){
    const x=setup(t);x.send('Just close my card');const r=x.send(text);assert.equal(r.session.closureStep,'points',text);assert.equal(x.store.get(x.id).customer.reward_points,2000,text);assert.ok(!r.session.closure);
  }
  const x=setup(t);x.send('Just close my card');const r=x.send('nahi redeem mat karna');assert.equal(r.session.closureStep,'confirm');assert.equal(r.session.checklist.points,2000);assert.ok(!r.session.closure);
});
test('a named redemption request can revise a skip, but a yes after a detour needs the question again',t=>{
  const x=setup(t);x.send('Just close my card');x.send('What are my dues?');let r=x.send('haan kar do');assert.equal(r.session.closureStep,'points');assert.equal(x.store.get(x.id).customer.reward_points,2000);
  x.send('skip');r=x.send('actually redeem my points please');assert.equal(r.session.checklist.points,0);assert.equal(r.session.closureStep,'confirm');
});
test('redemption wording at final confirmation never closes an account, and voice confirmation stays gated',t=>{
  const x=setup(t);x.send('Just close my card');x.send('haan redeem kar do');x.send('haan redeem kar do');let r=x.send('haan close kar do',{channel:'voice',confidence:null});assert.equal(r.session.state,'CLOSURE_FLOW');
  r=x.send('haan close kar do',{channel:'voice',confidence:null});assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(x.store.get(x.id).voiceReconfirmations,1);
  r=x.send('haan close kar do',{channel:'voice',confidence:null});assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(x.store.get(x.id).voiceReconfirmations,1);
});
test('unfamiliar wording gets a contextual model clarification, not an assumed redemption',t=>{
  const x=setup(t);x.send('Just close my card');const s=x.store.get(x.id),context=classifierContext(s);assert.equal(context.pendingAction,'redeem_points');assert.match(context.lastAssistant,/Redeem/);
  let r=x.send('use those leftover loyalty credits',{fallback:{intent:'redemption_request',reason:'unknown'}});assert.equal(r.reply.kind,'clarification');assert.equal(r.session.checklist.points,2000);
  r=x.send('yes');assert.equal(r.session.closureStep,'confirm');assert.equal(r.session.checklist.points,0);assert.ok(!r.session.closure);
});
test('lost-card reasoning interrupts retention and separates blocking from permanent closure',t=>{
  for(const text of ['I wanna close my card because it got lost','mera card kho gaya hai band karna hai','मेरा कार्ड खो गया है, बंद कर दो','My card was stolen']){
    const x=setup(t,'H-CARD-1');const r=x.send(text);assert.equal(r.session.state,'CARD_SECURITY',text);assert.equal(r.session.offerCount,0);assert.equal(r.session.reasonQuestions,0);assert.equal(r.session.pendingAction,'security_choice');assert.ok(!r.session.closure);
  }
  const x=setup(t,'H-CARD-1');x.send('I want to close my card because it got lost');let r=x.send('haan');assert.equal(r.session.state,'CARD_SECURITY');
  r=x.send('block kardo');assert.equal(r.session.state,'HANDOFF');assert.equal(r.session.cases[0].queue,'card_security');assert.match(r.reply.text,/block|replace/);assert.equal(r.session.offerCount,0);
  r=x.send('Is it blocked now?');assert.match(r.reply.text,/has not blocked/);assert.ok(!r.session.closure);
  r=x.send('Just close the account');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(r.session.offerCount,0);
});
test('lost-card concerns invalidate stale confirmations and recovery does not apply the old offer',t=>{
  const x=setup(t);x.send('Just close my card');let r=x.send('skip');const token=r.session.confirmationToken;
  r=x.send('my card is missing');assert.equal(r.session.state,'CARD_SECURITY');assert.equal(r.session.confirmationToken,null);
  assert.throws(()=>x.send('',{action:'confirm_closure',token}),/not pending/);
  r=x.send('I found my card');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(r.session.closureStep,'paused');assert.equal(r.session.confirmationToken,null);
  const y=setup(t,'H-CARD-1');y.send('The fee is too high');y.send('my card is lost');r=y.send('I found my card');assert.equal(r.session.state,'DECIDE');assert.equal(r.session.offerCount,1);assert.equal(y.store.db.prepare('SELECT COUNT(*) n FROM actions').get().n,0);
});
test('hypothetical and negated losses, or lost points, do not create a security incident',t=>{
  for(const text of ['What if my card is lost?','I have not lost my card','My card is not stolen','I lost my points on the card'])assert.notEqual(classify(text).intent,'card_incident',text);
  const x=setup(t,'H-CARD-1');const r=x.send('What if my card is lost?');assert.equal(r.session.state,'ANALYSE');assert.equal(r.session.offerCount,0);assert.equal(r.session.cases.length,0);
});
test('a supplied reason is not asked for again when it is outside retention policy',t=>{
  const x=setup(t);const r=x.send('I want to close my card because I am moving abroad');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(r.session.reasonQuestions,0);assert.equal(r.session.offerCount,0);
});
test('a lost-card report before identification is preserved without reading account facts',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,loadPolicy()),created=engine.create();const send=text=>engine.handle(created.session.id,{text});
  let r=send('I want to close my card because it got lost');assert.equal(r.session.customer,null);assert.match(r.reply.text,/issuer/);assert.ok(!r.session.trace.some(e=>e.kind==='SERVICE'));
  send('Riya Deshmukh');r=send('yes');assert.equal(r.session.state,'CARD_SECURITY');assert.equal(r.session.offerCount,0);assert.doesNotMatch(r.reply.text,/contact its issuer immediately/);assert.match(r.reply.text,/Blocking the card and closing the account are different/);
});
test('an unclear answer receives a repair rather than an identical points prompt forever',t=>{
  const x=setup(t);x.send('Just close my card');const a=x.send('something unclear'),b=x.send('something else unclear');assert.notEqual(a.reply.text,b.reply.text);assert.equal(b.session.closureStep,'points');assert.equal(x.store.get(x.id).customer.reward_points,2000);assert.ok(b.session.trace.some(e=>e.detail.rule==='dialogue_repair'));
});
test('frustration explains the pending step, and a negated skip is not a redemption refusal',t=>{
  const x=setup(t);x.send('Just close my card');let r=x.send('you keep repeating the same thing');assert.match(r.reply.text,/doesn’t submit closure/);assert.equal(r.session.closureStep,'points');
  r=x.send("don't skip, redeem my points please");assert.equal(r.session.closureStep,'confirm');assert.equal(r.session.checklist.points,0);
});
test('a direct lost-card blocking request creates only a simulated support case',t=>{
  const x=setup(t,'H-CARD-1');const r=x.send('My card is lost, please block it');assert.equal(r.session.state,'HANDOFF');assert.equal(r.session.cases[0].queue,'card_security');assert.match(r.reply.text,/has not blocked/);assert.ok(!r.session.closure);assert.equal(r.session.offerCount,0);
});
