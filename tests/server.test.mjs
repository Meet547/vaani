import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';
import {createApplication} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {loadPolicy} from '../lib/policy.mjs';

async function setup(t,overrides={}){
  const app=createApplication({store:new Store(':memory:'),policy:loadPolicy({customerSource:'fixtures'}),...overrides});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.shutdown());
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  return {...app,origin,async session(customerId='H-CARD-4'){
    const r=await fetch(`${origin}/api/sessions`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({customerId})});
    return {response:r,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }};
}
test('CSV directory endpoints expose safe profiles and enforce gold/data gates on session creation',async t=>{
  const x=await setup(t,{policy:loadPolicy()});
  const config=await fetch(x.origin+'/api/config').then(r=>r.json());assert.equal(config.customers.length,250);assert.equal(config.dataset.cardReady,148);
  const gold=await fetch(x.origin+'/api/customers/H-LR-1').then(r=>r.json());assert.equal(gold.gold.readOnly,true);assert.equal(gold.canStartCard,false);assert.equal(gold.card,null);
  const card=await fetch(x.origin+'/api/customers/H-CARD-4').then(r=>r.json());assert.equal(card.card.rewardPoints,2000);assert.equal(card.policyTier,'C');
  for(const key of ['EXP_','phone_fake','cibil_score_on_file','voice_stt_confidence_on_confirm'])assert.ok(!JSON.stringify(card).includes(key));
  assert.equal((await fetch(x.origin+'/api/customers/not-a-customer')).status,404);
  assert.equal((await fetch(x.origin+'/config/datasets/bombaybank_card_gold_synthetic_250.csv')).status,404);
  for(const id of ['H-LR-1','C0058','C0066']){const rejected=await x.session(id);assert.equal(rejected.response.status,400);assert.equal(rejected.cookie,undefined);}
  const created=await x.session('C0001');assert.equal(created.response.status,201);assert.equal(created.data.session.customer.id,'C0001');assert.equal(created.data.session.customer.sourceRevision,config.dataset.revision);
});
async function connect(x,cookie,textOnly=true){
  const socket=new WebSocket(x.origin.replace('http','ws')+'/voice',{origin:x.origin,headers:{Cookie:cookie}});
  const inbox=[],waiters=[];
  socket.on('message',data=>{const event=JSON.parse(data);const index=waiters.findIndex(w=>w.type===event.type);if(index>=0){const [w]=waiters.splice(index,1);clearTimeout(w.timeout);w.resolve(event);}else inbox.push(event);});
  await once(socket,'open');
  const wait=type=>{const index=inbox.findIndex(e=>e.type===type);if(index>=0)return Promise.resolve(inbox.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={type,resolve,timeout:setTimeout(()=>reject(new Error(`Timed out waiting for ${type}`)),3000)};waiters.push(waiter);});};
  socket.send(JSON.stringify({type:'start',textOnly}));await wait('ready');
  return {socket,wait,send:message=>socket.send(JSON.stringify(message))};
}
test('HTTP authentication, origin, static path and secret boundaries',async t=>{
  const x=await setup(t);
  assert.equal((await fetch(x.origin+'/api/health')).status,200);
  assert.equal((await fetch(x.origin+'/api/session')).status,401);
  assert.equal((await fetch(x.origin+'/.env')).status,404);
  assert.equal((await fetch(x.origin+'/data/aria.sqlite')).status,404);
  const config=await fetch(x.origin+'/api/config').then(r=>r.json());assert.equal(config.mode,'demo');assert.ok(!JSON.stringify(config).includes('api_key'));
  const denied=await fetch(x.origin+'/api/sessions',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
  const s=await x.session();assert.equal(s.response.status,201);assert.match(s.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const restored=await fetch(x.origin+'/api/session',{headers:{Cookie:s.cookie}}).then(r=>r.json());assert.equal(restored.session.id,s.data.session.id);
});
test('WebSocket rejects missing authentication and foreign origins',async t=>{
  const x=await setup(t),session=await x.session();
  for(const options of [{origin:x.origin},{origin:'https://untrusted.example',headers:{Cookie:session.cookie}}]){
    const socket=new WebSocket(x.origin.replace('http','ws')+'/voice',options);const [error]=await once(socket,'error');assert.match(error.message,/403/);
  }
});
test('chat works with no provider credentials; confirmed closure is persisted and duplicate-safe',async t=>{
  const x=await setup(t),s=await x.session(),client=await connect(x,s.cookie);t.after(()=>client.socket.close());
  client.send({type:'text',text:'just close it',messageId:'close'});
  const initial=await client.wait('session');assert.equal(initial.session.closureStep,'confirm');
  const turn=await client.wait('turn_done');assert.equal(turn.audio,false);
  client.send({type:'action',action:'confirm_closure',token:initial.session.confirmationToken,expectedRevision:initial.session.revision,messageId:'confirm'});
  const submitted=await client.wait('session');assert.equal(submitted.session.closure.status,'pending_dues');await client.wait('turn_done');
  client.send({type:'action',action:'confirm_closure',token:initial.session.confirmationToken,expectedRevision:initial.session.revision,messageId:'confirm'});
  const duplicate=await client.wait('session');assert.equal(duplicate.session.closure.reference,submitted.session.closure.reference);
  assert.equal(x.store.db.prepare('SELECT COUNT(*) AS n FROM closures').get().n,1);
});
test('client cannot override customer identity, confidence, caps or confirmation purpose',async t=>{
  const x=await setup(t),s=await x.session(),c=await connect(x,s.cookie);t.after(()=>c.socket.close());
  c.send({type:'text',text:'just close it',customerId:'H-CARD-1',verified:false,confidence:1,channel:'voice',messageId:'a'});
  const r=await c.wait('session');assert.equal(r.session.customer.id,'H-CARD-4');assert.equal(r.session.closureStep,'confirm');await c.wait('turn_done');
  c.send({type:'action',action:'accept_offer',token:r.session.confirmationToken,messageId:'b'});
  assert.match((await c.wait('error')).message,/No offer/);assert.equal(x.store.db.prepare('SELECT COUNT(*) AS n FROM closures').get().n,0);
});
test('voice provider failure preserves the written reply and saved policy state',async t=>{
  const providers={speechStream:()=>({push(){},end:async()=>{throw new Error('synthetic upstream failure');}})};
  const x=await setup(t,{credentials:{sarvam:'test-only'},providers}),s=await x.session('H-CARD-1'),c=await connect(x,s.cookie);t.after(()=>c.socket.close());
  c.send({type:'text',text:'The fee is too high',messageId:'offer'});
  assert.equal((await c.wait('session')).session.state,'DECIDE');assert.match((await c.wait('error')).message,/written response/);assert.equal((await c.wait('turn_done')).audio,false);
  assert.equal(x.store.get(s.data.session.id).offerCount,1);
});
test('intent provider failure yields a safe clarification without an offer or action',async t=>{
  const x=await setup(t,{credentials:{ollama:'test-only'},providers:{classifyWithModel:async()=>{throw new Error('unavailable');}}}),s=await x.session(),c=await connect(x,s.cookie);t.after(()=>c.socket.close());
  c.send({type:'text',text:'something quite unusual',messageId:'unknown'});const r=await c.wait('session');assert.equal(r.session.offerCount,0);assert.equal(r.session.state,'ANALYSE');assert.ok(r.session.trace.some(e=>e.detail.rule==='classifier_unavailable'));
});
test('transport treats model intent as a clarification and skips the model during closure',async t=>{
  let calls=0;const x=await setup(t,{credentials:{ollama:'test-only'},providers:{classifyWithModel:async()=>{calls++;return {intent:'closure_firm',reason:'unknown'};}}}),s=await x.session(),c=await connect(x,s.cookie);t.after(()=>c.socket.close());
  c.send({type:'text',text:'this is complicated'});let r=await c.wait('session');assert.equal(r.session.state,'ANALYSE');assert.equal(r.session.closureLocked,false);assert.equal(calls,1);await c.wait('turn_done');
  c.send({type:'text',text:'yes'});r=await c.wait('session');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(calls,1);await c.wait('turn_done');
  c.send({type:'text',text:'something complicated again',fallback:{intent:'accept',reason:'fee'}});r=await c.wait('session');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(calls,1);assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM closures').get().n,0);
});
test('provider language confidence never turns uncertain spoken yes into a closure',async t=>{
  let event;
  const providers={speechStream:()=>({push(){},end:async()=>({audioCount:1})}),connectRecognition:callbacks=>{event=callbacks.onEvent;queueMicrotask(()=>event({event:'session.begin'}));return {readyState:1,send(){},close(){}};}};
  const x=await setup(t,{credentials:{sarvam:'test-only'},providers}),s=await x.session(),c=await connect(x,s.cookie,false);t.after(()=>c.socket.close());
  c.send({type:'text',text:'just close it',messageId:'close'});assert.equal((await c.wait('session')).session.closureStep,'confirm');await c.wait('turn_done');
  event({event:'transcript.final',text:'yes',language_confidence:1,utterance_idx:0});const r=await c.wait('session');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(x.store.db.prepare('SELECT COUNT(*) AS n FROM closures').get().n,0);assert.ok(r.session.trace.some(e=>e.detail.rule==='voice_reconfirmation'));
});
test('normal conversation transport greets, identifies by name and ignores client identity spoofing',async t=>{
  let modelCalls=0;const x=await setup(t,{policy:loadPolicy(),credentials:{ollama:'test-only'},providers:{classifyWithModel:async()=>{modelCalls++;throw new Error('Should not classify identity');}}});
  const response=await fetch(x.origin+'/api/sessions',{method:'POST',headers:{Origin:x.origin,'Content-Type':'application/json'},body:JSON.stringify({mode:'conversation',customerId:'H-CARD-1',trigger:'card_closure_request'})});
  const created=await response.json();assert.equal(created.session.customer,null);assert.equal(created.session.state,'AWAITING_NAME');
  const c=await connect(x,response.headers.get('set-cookie').split(';')[0]);t.after(()=>c.socket.close());
  c.send({type:'text',text:'Hello.',customerId:'H-CARD-1',verified:true});let r=await c.wait('session');assert.equal(r.session.customer,null);assert.equal(r.session.offerCount,0);await c.wait('turn_done');
  c.send({type:'text',text:'My name is Riya Deshmukh.'});r=await c.wait('session');assert.equal(r.session.state,'CONFIRM_IDENTITY');assert.ok(!r.session.trace.some(e=>e.kind==='SERVICE'));await c.wait('turn_done');
  c.send({type:'text',text:"Yes, that's me."});r=await c.wait('session');assert.equal(r.session.customer.id,'H-CARD-1');assert.equal(r.session.state,'CHECK_CONTEXT');assert.equal(r.session.offerCount,0);assert.equal(modelCalls,0);
});
test('normal conversation saves reviewed synthetic profiles and exposes them in the directory',async t=>{
  const x=await setup(t,{policy:loadPolicy()});
  const response=await fetch(x.origin+'/api/sessions',{method:'POST',headers:{Origin:x.origin,'Content-Type':'application/json'},body:'{"mode":"conversation"}'});
  const c=await connect(x,response.headers.get('set-cookie').split(';')[0]);t.after(()=>c.socket.close());
  let latest;
  for(const text of ['My name is Kavya DemoPerson','yes','Pune','I need help with annual card fees.','yes']){c.send({type:'text',text});latest=(await c.wait('session')).session;await c.wait('turn_done');}
  assert.equal(latest.state,'PROFILE_READY');assert.equal(latest.hasCard,false);assert.equal(latest.offerCount,0);
  const config=await fetch(x.origin+'/api/config').then(r=>r.json());assert.equal(config.savedProfiles,1);assert.equal(config.customers.length,251);
  const profile=await fetch(x.origin+'/api/customers/'+latest.customer.id).then(r=>r.json());assert.equal(profile.name,'Kavya DemoPerson');assert.equal(profile.card,null);assert.equal(profile.canStartCard,false);
});
test('recognized spoken Hinglish redeems only points and preserves final voice confirmation gates',async t=>{
  let recognition,modelCalls=0;
  const providers={speechStream:()=>({push(){},end:async()=>({audioCount:1})}),classifyWithModel:async()=>{modelCalls++;throw new Error('Known speech should not need the model');},connectRecognition:callbacks=>{recognition=callbacks.onEvent;queueMicrotask(()=>recognition({event:'session.begin'}));return {readyState:1,send(){},close(){}};}};
  const x=await setup(t,{policy:loadPolicy(),credentials:{sarvam:'test',ollama:'test'},providers}),s=await x.session('H-CARD-4'),c=await connect(x,s.cookie,false);t.after(()=>c.socket.close());
  c.send({type:'text',text:'Just close my card'});assert.equal((await c.wait('session')).session.closureStep,'points');await c.wait('turn_done');
  recognition({event:'transcript.final',text:'haa kardo fir redeem',utterance_idx:0});let r=await c.wait('session');assert.equal(r.session.checklist.points,0);assert.equal(r.session.closureStep,'confirm');assert.equal(modelCalls,0);await c.wait('turn_done');
  recognition({event:'transcript.final',text:'haan close kar do',utterance_idx:1});r=await c.wait('session');assert.equal(r.session.state,'CLOSURE_FLOW');assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM closures').get().n,0);assert.ok(r.session.trace.some(e=>e.detail.rule==='voice_reconfirmation'));
});
test('the fallback model receives the pending question and must clarify an unfamiliar redemption request',async t=>{
  let context;
  const x=await setup(t,{policy:loadPolicy(),credentials:{ollama:'test'},providers:{classifyWithModel:async input=>{context=input.context;return {intent:'redemption_request',reason:'unknown'};}}}),s=await x.session('H-CARD-4'),c=await connect(x,s.cookie);t.after(()=>c.socket.close());
  c.send({type:'text',text:'Just close my card'});await c.wait('session');await c.wait('turn_done');
  c.send({type:'text',text:'use those leftover loyalty credits'});let r=await c.wait('session');assert.equal(context.pendingAction,'redeem_points');assert.equal(context.state,'CLOSURE_FLOW');assert.match(context.lastAssistant,/Redeem/);assert.equal(r.session.checklist.points,2000);await c.wait('turn_done');
  c.send({type:'text',text:'yes'});r=await c.wait('session');assert.equal(r.session.checklist.points,0);assert.equal(r.session.closureStep,'confirm');assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM closures').get().n,0);
});
