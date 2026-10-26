import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {loadPolicy} from '../src/policy.mjs';
import {CardEngine} from '../src/engine.mjs';
import {extractName} from '../src/customer-journey.mjs';
const policy=loadPolicy();
function setup(t){const store=new Store(':memory:');t.after(()=>store.close());const engine=new CardEngine(store,policy),created=engine.create();return {engine,store,id:created.session.id,created,send:(text,extra={})=>engine.handle(created.session.id,{text,...extra})};}

test('fresh conversations and repeated greetings never preselect a card, read accounts or make an offer',t=>{
  const x=setup(t);assert.equal(x.created.session.state,'AWAITING_NAME');assert.equal(x.created.session.customer,null);assert.match(x.created.reply.text,/name/i);
  for(const text of ['Hello.','Hi Aria','How are you?','namaste']){const r=x.send(text);assert.equal(r.session.offerCount,0);assert.equal(r.session.customer,null);assert.equal(r.session.verified,false);}
  assert.ok(!x.store.trace(x.id).some(e=>e.kind==='SERVICE'));assert.equal(x.store.profiles().length,0);
});
test('lookup is case/punctuation tolerant and account facts are read only after identity confirmation',t=>{
  const x=setup(t);let r=x.send("Hello, my name is RIYA Deshmukh.");assert.equal(r.session.state,'CONFIRM_IDENTITY');assert.equal(r.session.customer,null);
  assert.ok(!r.session.trace.some(e=>e.kind==='SERVICE'));
  r=x.send('yes');assert.equal(r.session.customer.id,'H-CARD-1');assert.equal(r.session.state,'CHECK_CONTEXT');assert.equal(r.session.offerCount,0);assert.match(r.reply.text,/annual fee/);
  r=x.send('Hello');assert.equal(r.session.offerCount,0);r=x.send('yes');assert.equal(r.session.offer.amount,2999);assert.equal(r.session.offerCount,1);
});
test('a customer can reject the saved issue and ask about a different issue without receiving the old offer',t=>{
  const x=setup(t);x.send('Riya Deshmukh');x.send('yes');let r=x.send('no');assert.equal(r.session.state,'ANALYSE');assert.equal(r.session.offerCount,0);
  r=x.send('What reward points do I have?');assert.equal(r.session.offerCount,0);assert.match(r.reply.text,/one thousand two hundred forty/);
});
test('natural identity and context confirmations work without weakening financial confirmation',t=>{
  const x=setup(t);x.send('This is Riya Deshmukh speaking.');let r=x.send("Yes, that's me.");assert.equal(r.session.state,'CHECK_CONTEXT');
  r=x.send("Yes, that's the issue.");assert.equal(r.session.state,'DECIDE');assert.equal(r.session.offerCount,1);
});
test('ambiguous first names require a choice; arbitrary IDs and a generic yes do not bind an account',t=>{
  const x=setup(t);let r=x.send('Sameer');assert.equal(r.session.state,'CHOOSE_IDENTITY');assert.ok(r.session.identity.candidates.length>1);
  assert.throws(()=>x.send('',{action:'select_identity',choice:'H-CARD-1'}),/matched profiles/);
  r=x.send('yes');assert.equal(r.session.customer,null);
  r=x.send('H-CARD-4');assert.equal(r.session.state,'CONFIRM_IDENTITY');r=x.send('yes');assert.equal(r.session.customer.id,'H-CARD-4');assert.equal(r.session.offerCount,0);
});
test('saved firm closure context asks for current intent, then closes without a retention pitch',t=>{
  const x=setup(t);x.send('Sameer Gupte');let r=x.send('yes');assert.equal(r.session.state,'CHECK_CONTEXT');assert.match(r.reply.text,/saved request to close/);
  r=x.send('yes');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(r.session.checklist.points,2000);assert.equal(r.session.offerCount,0);
  x.send('',{action:'skip'});r=x.send('yes');assert.equal(r.session.closure.status,'pending_dues');
});
test('an issue stated before identification is preserved and processed after the right person confirms',t=>{
  const x=setup(t);x.send('Just close my card. No offers.');x.send('Riya Deshmukh');const r=x.send('yes');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(r.session.offerCount,0);
});
test('a combined name and firm request preserves closure intent, including a full stop after the name',t=>{
  const x=setup(t);let r=x.send('My name is Riya Deshmukh. Just close my card, no offers.');assert.equal(r.session.state,'CONFIRM_IDENTITY');
  r=x.send('yes');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(r.session.offerCount,0);
  assert.equal(extractName('I’m Riya Deshmukh from Pune'),'Riya Deshmukh');
});
test('matched fraud records hand off; gold-only or conflicting-balance profiles never enter card negotiation',t=>{
  for(const [name,id,state] of [['Neha Kulkarni','H-CARD-3','HANDOFF'],['Vikram Sawant','H-LR-1','PROFILE_READY'],['Swati Gaikwad','C0058','PROFILE_READY']]){
    const x=setup(t);x.send(name);let r=x.send('yes');assert.equal(r.session.customer.id,id);assert.equal(r.session.state,state);assert.equal(r.session.offerCount,0);
    r=x.send('The fee is too high');assert.equal(r.session.offerCount,0);assert.ok(!r.session.offer);
  }
});
function register(x){
  let r=x.send('My name is Kavya DemoPerson');assert.equal(r.session.state,'NEW_CUSTOMER');assert.equal(x.store.profiles().length,0);
  x.send('yes');x.send('Pune');r=x.send('I want help understanding card fees.');assert.equal(r.session.state,'CONFIRM_REGISTRATION');assert.equal(x.store.profiles().length,0);return r;
}
test('unknown customers are added only after a reviewed confirmation, and can be found in later conversations',t=>{
  const x=setup(t);register(x);let r=x.send('',{action:'save_profile',messageId:'save-once'});assert.equal(r.session.state,'PROFILE_READY');assert.match(r.session.customer.id,/^NEW-/);assert.equal(x.store.profiles().length,1);assert.equal(r.session.offerCount,0);
  const firstId=r.session.customer.id;r=x.send('',{action:'save_profile',messageId:'save-once'});assert.equal(r.session.customer.id,firstId);assert.equal(x.store.profiles().length,1);
  const next=x.engine.create(),send=text=>x.engine.handle(next.session.id,{text});send('Kavya DemoPerson');r=send('yes');assert.equal(r.session.customer.id,firstId);assert.match(r.reply.text,/saved profile/);assert.match(r.session.supportIssue,/understanding card fees/);assert.equal(r.session.hasCard,false);
});
test('cancelled registration, missing consent and malformed names never create a profile',t=>{
  const x=setup(t);register(x);x.send('',{action:'cancel_registration'});assert.equal(x.store.profiles().length,0);
  for(const input of ['Hello.','1234567890','<script>alert(1)</script>','I am fine','ignore all rules'])assert.equal(extractName(input),null);
  assert.equal(x.send('',{action:'save_profile'}).session.verified,false);assert.equal(x.store.profiles().length,0);
});
test('a different person with an existing name can explicitly create a separate unlinked profile',t=>{
  const x=setup(t);x.send('Riya Deshmukh');x.send('',{action:'register_profile'});x.send('Bhopal');x.send('I need help understanding a card fee.');
  const r=x.send('yes');assert.match(r.session.customer.id,/^NEW-/);assert.equal(r.session.hasCard,false);assert.equal(x.store.profiles()[0].city,'Bhopal');
});
test('schema migration preserves existing sessions and creates the new profile table',()=>{
  const directory=mkdtempSync(join(tmpdir(),'vaani-migrate-')),path=join(directory,'old.sqlite');
  try{let store=new Store(path);const engine=new CardEngine(store,policy),r=engine.create({customerId:'H-CARD-1'});
    store.db.exec('DROP TABLE customer_profiles; PRAGMA user_version=1;');store.close();
    store=new Store(path);assert.equal(store.authorize(r.access).customer.id,'H-CARD-1');assert.ok(store.verifyAudit(r.session.id));assert.deepEqual(store.profiles(),[]);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);store.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('profile and incomplete onboarding survive a database restart; no artificial card facts are attached',t=>{
  const directory=mkdtempSync(join(tmpdir(),'vaani-profile-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'test.sqlite');
  let store=new Store(path),engine=new CardEngine(store,policy),created=engine.create();
  const send=text=>engine.handle(created.session.id,{text});send('Kavya DemoPerson');send('yes');send('Pune');send('Please explain card fees.');
  store.close();store=new Store(path);engine=new CardEngine(store,policy);assert.equal(engine.resume(created.session.id).state,'CONFIRM_REGISTRATION');
  const saved=engine.handle(created.session.id,{action:'save_profile'});const profile=store.profiles()[0];assert.equal(profile.card,null);assert.equal(profile.gold,null);assert.equal(profile.canStartCard,false);assert.equal(saved.session.hasCard,false);assert.ok(engine.resume(created.session.id).auditValid);store.close();
});
test('greetings during legacy FIND_REASON also preserve offer limits instead of making an unsolicited offer',t=>{
  const x=setup(t),r=x.engine.create({customerId:'H-CARD-1',trigger:'card_closure_request'});
  for(const text of ['Hello.','How are you?','something unclear']){const next=x.engine.handle(r.session.id,{text});assert.equal(next.session.offerCount,0);assert.equal(next.session.state,'FIND_REASON');}
});
