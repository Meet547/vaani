import {writeFile,mkdir} from 'node:fs/promises';
import WebSocket from 'ws';
const origin='http://localhost:4317';
const response=await fetch(origin+'/api/sessions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({customerId:'H-CARD-1'})});
if(!response.ok)throw new Error('Start the configured local demo first.');
const cookie=response.headers.get('set-cookie').split(';')[0], chunks=[],transcript=[];
const prompts=['The annual fee is too high.','No, just close it.','Skip it.'];
await new Promise((resolve,reject)=>{
  const ws=new WebSocket('ws://localhost:4317/voice',{origin,headers:{Cookie:cookie}});
  const timeout=setTimeout(()=>{ws.close();reject(new Error('Backup clip timed out'));},90000);let index=0;
  const next=()=>ws.send(JSON.stringify({type:'text',text:prompts[index++]}));
  ws.on('open',()=>ws.send(JSON.stringify({type:'start',textOnly:true})));
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='ready')next();if(m.type==='audio')chunks.push(Buffer.from(m.audio,'base64'));if(m.type==='turn_done'){transcript.push(m.text);chunks.push(Buffer.alloc(24000));if(index<prompts.length)next();else{clearTimeout(timeout);ws.close();resolve();}}if(m.type==='error'){clearTimeout(timeout);ws.close();reject(new Error(m.message));}});ws.on('error',reject);
});
const data=Buffer.alloc(30*24000*2),header=Buffer.alloc(44);Buffer.concat(chunks).copy(data,0,0,data.length);
// Fade the final excerpt boundary instead of cutting a generated word abruptly.
for(let i=0;i<7200;i++){const offset=data.length-14400+i*2;data.writeInt16LE(Math.round(data.readInt16LE(offset)*(1-i/7200)),offset);}
header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/aria-backup.wav',import.meta.url),Buffer.concat([header,data]));
await writeFile(new URL('../artifacts/aria-backup-transcript.json',import.meta.url),JSON.stringify({synthetic:true,durationSeconds:data.length/48000,note:'Excerpt of generated assistant speech; ending may be mid-turn.',turns:transcript},null,2));
console.log(`Saved synthetic backup clip (${data.length/48000} seconds).`);
