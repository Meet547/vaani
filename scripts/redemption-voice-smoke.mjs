import assert from 'node:assert/strict';
import readline from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {speechStream} from '../src/providers.mjs';

// Synthetic speech only. Launch with terminal echo disabled and supply the
// Sarvam key as one JSON line on stdin; credentials are never written to disk.
const base=new URL(process.argv[2]||'http://localhost:4317').origin;
const prompt=readline.createInterface({input:process.stdin,output:process.stdout,terminal:false});
console.log('Waiting for speech test credentials on stdin (use terminal echo off).');
const credentials=JSON.parse(await new Promise(resolve=>prompt.once('line',resolve)));prompt.close();
assert.equal(typeof credentials.sarvam,'string');
const chunks=[];let sampleRate;
const speech=speechStream({key:credentials.sarvam,model:process.env.SARVAM_TTS_MODEL||'bulbul:v4-flash',config:{voice:'warm',pace:1},language:'hi-IN',signal:new AbortController().signal,onAudio:data=>{sampleRate=data.sample_rate;chunks.push(Buffer.from(data.audio,'base64'));}});
speech.push('हाँ कर दो फिर रिडीम।');await speech.end();
const source=Buffer.concat(chunks);assert.ok(source.length>0);
const samples=Math.floor(source.length/2),length=Math.floor(samples*16000/sampleRate),pcm=Buffer.alloc(length*2);
for(let i=0;i<length;i++){
  const position=i*sampleRate/16000,first=Math.floor(position),fraction=position-first;
  const a=source.readInt16LE(first*2),b=source.readInt16LE(Math.min(first+1,samples-1)*2);
  pcm.writeInt16LE(Math.round(a+(b-a)*fraction),i*2);
}
const headers={Origin:base,'Content-Type':'application/json'};
async function api(path,options){const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(55000)});const data=await response.json();assert.ok(response.ok,data.error||String(response.status));return {data,response};}
const created=await api('/api/sessions',{method:'POST',headers,body:JSON.stringify({customerId:'H-CARD-4',channel:'voice'})});
const cookie=created.response.headers.get('set-cookie').split(';')[0];
const {data:ticket}=await api('/api/voice-ticket',{method:'POST',headers:{...headers,Cookie:cookie}});
const socket=new WebSocket(ticket.url,['vaani',`ticket.${ticket.ticket}`],{origin:base,handshakeTimeout:15000});
const inbox=[],waiters=[],transcripts=[];
socket.on('message',raw=>{
  const event=JSON.parse(raw);if(event.type==='user_text')transcripts.push(event.text);
  const index=waiters.findIndex(w=>w.type===event.type);
  if(index>=0){const [w]=waiters.splice(index,1);clearTimeout(w.timer);w.resolve(event);}
  else if(event.type!=='audio')inbox.push(event);
});
socket.on('error',error=>{for(const w of waiters.splice(0)){clearTimeout(w.timer);w.reject(error);}});
const wait=type=>{
  const index=inbox.findIndex(event=>event.type===type);if(index>=0)return Promise.resolve(inbox.splice(index,1)[0]);
  return new Promise((resolve,reject)=>{const w={type,resolve,reject};w.timer=setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(new Error(`Speech check timed out waiting for ${type}`));},40000);waiters.push(w);});
};
try{
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  socket.send(JSON.stringify({type:'start',textOnly:false}));await wait('ready');
  socket.send(JSON.stringify({type:'text',text:'Just close my card.',messageId:crypto.randomUUID()}));
  assert.equal((await wait('session')).session.closureStep,'points');const question=await wait('turn_done');socket.send(JSON.stringify({type:'played',turn:question.turn}));
  for(let offset=0;offset<pcm.length;offset+=3200){socket.send(pcm.subarray(offset,offset+3200));await delay(100);}
  for(let i=0;i<20;i++){socket.send(Buffer.alloc(3200));await delay(100);}
  const result=await wait('session');await wait('turn_done');
  assert.equal(result.session.state,'CLOSURE_FLOW');assert.equal(result.session.closureStep,'confirm');assert.equal(result.session.checklist.points,0);assert.ok(!result.session.closure);
  console.log(JSON.stringify({result:'PASS',transcript:transcripts.slice(1),step:result.session.closureStep,remainingPoints:result.session.checklist.points,closureSubmitted:Boolean(result.session.closure)}));
}finally{
  for(const w of waiters.splice(0))clearTimeout(w.timer);
  socket.close();const timer=setTimeout(()=>socket.terminate(),1000);timer.unref();
}
