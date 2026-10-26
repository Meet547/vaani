import WebSocket from 'ws';
import assert from 'node:assert/strict';
const origin='http://localhost:4317';
const response=await fetch(origin+'/api/sessions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({customerId:'H-CARD-1'})});
assert.equal(response.status,201);const cookie=response.headers.get('set-cookie').split(';')[0];
await new Promise((resolve,reject)=>{
  const ws=new WebSocket('ws://localhost:4317/voice',{origin,headers:{Cookie:cookie}});
  const timeout=setTimeout(()=>{ws.close();reject(new Error('Classifier smoke timed out'));},12000);
  ws.on('open',()=>ws.send(JSON.stringify({type:'start',textOnly:true})));
  ws.on('message',raw=>{
    const m=JSON.parse(raw);
    if(m.type==='ready')ws.send(JSON.stringify({type:'text',text:"I'd like to terminate my credit card relationship.",messageId:'classifier-check'}));
    if(m.type==='session'){
      clearTimeout(timeout);ws.close();
      try{const event=m.session.trace.findLast(e=>e.kind==='INTENT');assert.equal(event.detail.source,'model_classifier');assert.ok(['closure_soft','closure_firm'].includes(event.detail.intent));console.log(JSON.stringify({result:'PASS',intent:event.detail.intent,source:event.detail.source,state:m.session.state}));resolve();}catch(error){reject(error);}
    }
    if(m.type==='error'){clearTimeout(timeout);ws.close();reject(new Error(m.message));}
  });ws.on('error',reject);
});
