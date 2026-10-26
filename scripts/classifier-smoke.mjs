import WebSocket from 'ws';
import assert from 'node:assert/strict';
const origin='http://localhost:4317';
const response=await fetch(origin+'/api/sessions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({customerId:'H-CARD-1'})});
assert.equal(response.status,201);const cookie=response.headers.get('set-cookie').split(';')[0];
await new Promise((resolve,reject)=>{
  let clarified=false;
  const ws=new WebSocket('ws://localhost:4317/voice',{origin,headers:{Cookie:cookie}});
  const timeout=setTimeout(()=>{ws.close();reject(new Error('Classifier smoke timed out'));},12000);
  ws.on('open',()=>ws.send(JSON.stringify({type:'start',textOnly:true})));
  ws.on('message',raw=>{
    const m=JSON.parse(raw);
    if(m.type==='ready')ws.send(JSON.stringify({type:'text',text:"I'd like to terminate my credit card relationship.",messageId:'classifier-check'}));
    if(m.type==='session'){
      try{
        if(!clarified){
          const guard=m.session.trace.findLast(e=>e.detail.rule==='model_intent_requires_clarification');
          assert.ok(guard);assert.ok(['closure_soft','closure_firm'].includes(guard.detail.suggestion.intent));assert.equal(m.session.state,'ANALYSE');assert.equal(m.session.closureLocked,false);assert.equal(m.session.offerCount,0);
          clarified=true;ws.send(JSON.stringify({type:'text',text:'yes',messageId:'classifier-confirm'}));return;
        }
        const event=m.session.trace.findLast(e=>e.kind==='INTENT');assert.equal(event.detail.source,'caller_confirmed_model');assert.ok(['FIND_REASON','CLOSURE_FLOW'].includes(m.session.state));
        clearTimeout(timeout);ws.close();console.log(JSON.stringify({result:'PASS',intent:event.detail.intent,source:event.detail.source,state:m.session.state}));resolve();
      }catch(error){clearTimeout(timeout);ws.close();reject(error);}
    }
    if(m.type==='error'){clearTimeout(timeout);ws.close();reject(new Error(m.message));}
  });ws.on('error',reject);
});
