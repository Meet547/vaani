import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { parse } from 'yaml';
import { WebSocketServer, WebSocket } from 'ws';
import { settings, takeSentences, cleanSpeech, voices } from './lib/conversation.mjs';
import { speechStream, connectRecognition, classifyWithModel } from './lib/providers.mjs';
import { loadPolicy, metrics, assignTier } from './lib/policy.mjs';
import { customerIndex } from './lib/customer-data.mjs';
import { Store } from './lib/store.mjs';
import { CardEngine } from './lib/engine.mjs';
import { classify } from './lib/intents.mjs';
import {canUseModel,classifierContext} from './lib/dialogue.mjs';
import { redact } from './lib/privacy.mjs';
import { loadDeployment, securityHeaders } from './lib/deployment.mjs';
import { VoiceTickets, readCookie, cookieValue } from './lib/transport-auth.mjs';

const runtime=parse(readFileSync(new URL('./config/runtime.yaml',import.meta.url),'utf8'));
if(runtime.host!=='127.0.0.1')throw new Error('Use DEPLOYMENT_TARGET=render for hosted binding; keep the local runtime on loopback.');
for(const [name,value] of Object.entries(runtime))if(name!=='host'&&(!Number.isSafeInteger(value)||value<=0))throw new Error(`Invalid runtime setting: ${name}`);
const files=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']],['/mic-worklet.js',['mic-worklet.js','text/javascript']],['/demo-backup.wav',['../artifacts/aria-backup.wav','audio/wav']]]);
files.set('/conversation.css',['conversation.css','text/css']);

export function createApplication({credentials={},deployment=loadDeployment(),store=new Store(deployment.databasePath||fileURLToPath(new URL('./data/aria.sqlite',import.meta.url))),policy=loadPolicy(),providers={speechStream,connectRecognition,classifyWithModel},model=process.env.OLLAMA_MODEL||'gemma4:31b',ttsModel=process.env.SARVAM_TTS_MODEL||'bulbul:v4-flash',sttModel=process.env.SARVAM_STT_MODEL||'saaras:v4'}={}) {
  const engine=new CardEngine(store,policy), voiceAvailable=Boolean(credentials.sarvam), shuttingDown={value:false};
  const tickets=new VoiceTickets();
  const sessionCookie=deployment.secure?'__Host-vaani_session':'aria_session';
  const cookie=req=>readCookie(req,sessionCookie);
  engine.scanDeadlines();
  const deadlineScanner=setInterval(()=>{try{engine.scanDeadlines();}catch{console.error('Demo deadline scan failed; inspect database integrity.');}},runtime.deadline_scan_ms);deadlineScanner.unref();
  const controlRates=new Map();
  const validHost=req=>deployment.backendOrigin?deployment.backendHosts.includes(req.headers.host):[`localhost:${server.address()?.port}`,`127.0.0.1:${server.address()?.port}`].includes(req.headers.host);
  const validOrigin=req=>deployment.backendOrigin?deployment.frontendOrigins.includes(req.headers.origin):req.headers.origin===`http://${req.headers.host}`;
  const allowedRate=(req,bucket='sessions',limit=runtime.messages_per_window,window=runtime.message_window_ms)=>{
    const key=bucket+':'+req.socket.remoteAddress,now=Date.now(),rate=controlRates.get(key)||{start:now,count:0};
    if(now-rate.start>window){rate.start=now;rate.count=0;}
    controlRates.set(key,rate);return ++rate.count<=limit;
  };
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    for(const [key,value] of Object.entries(securityHeaders(deployment.backendOrigin)))res.setHeader(key,value);
    if(!validHost(req))return json(res,403,{error:'Invalid host.'});
    if(shuttingDown.value)return json(res,503,{error:'Server is shutting down.'});
    const pathname=req.url?.split('?')[0];
    if(req.method==='GET') {
      if(pathname==='/api/health'){
        try{store.db.prepare('SELECT 1').get();return json(res,200,{status:'ready',mode:'demo',voiceConfigured:voiceAvailable,dialogueConfigured:Boolean(credentials.ollama)});}catch{return json(res,503,{status:'unavailable'});}
      }
      if(pathname==='/api/config')return json(res,200,{configured:voiceAvailable,voiceAvailable,model,ttsModel,sttModel,voices,mode:'demo',policyVersion:policy.card.policy_version,dataset:policy.dataset||null,savedProfiles:store.profiles().length,customers:engine.journey.directory().map(customerIndex)});
      if(pathname.startsWith('/api/customers/')){
        const profile=engine.journey.profile(pathname.slice('/api/customers/'.length));
        if(!profile)return json(res,404,{error:'Customer not found.'});
        const customer=policy.customers.find(c=>c.id===profile.id),m=customer?metrics(customer,policy):null;
        return json(res,200,{...profile,policyTier:customer?assignTier(customer,m,policy):null,metrics:m});
      }
      if(pathname==='/api/session') {const s=store.authorize(cookie(req));return json(res,s?200:401,s?{session:engine.view(s)}:{error:'No saved session.'});}
      if(pathname==='/api/alerts') {const s=store.authorize(cookie(req));if(!s)return json(res,401,{error:'Session required.'});const alerts=engine.scanDeadlines();return json(res,200,{closures:alerts.closures.filter(a=>a.session_id===s.id),reviews:alerts.reviews.filter(a=>a.session_id===s.id)});}
      const file=files.get(pathname);if(!file)return json(res,404,{error:'Not found.'});
      try{res.setHeader('Content-Type',file[1]);return res.end(await readFile(new URL(`./public/${file[0]}`,import.meta.url)));}catch{return json(res,500,{error:'Interface could not be loaded.'});}
    }
    if(req.method==='POST'&&pathname==='/api/voice-ticket'){
      if(!validOrigin(req))return json(res,403,{error:'Trusted origin required.'});
      const access=cookie(req),session=store.authorize(access);
      if(!session)return json(res,401,{error:'Session required.'});
      if(!allowedRate(req,'ticket',30))return json(res,429,{error:'Too many connection requests. Please wait briefly.'});
      const origin=deployment.backendOrigin||`http://${req.headers.host}`;
      return json(res,200,{ticket:tickets.issue(access,req.headers.origin),url:origin.replace(/^http/,'ws')+'/voice',expiresIn:60});
    }
    if(req.method!=='POST'||pathname!=='/api/sessions')return json(res,405,{error:'Method not allowed.'});
    if(!validOrigin(req)||req.headers['content-type']?.split(';')[0]!=='application/json')return json(res,403,{error:'Same-origin JSON request required.'});
    if(!allowedRate(req))return json(res,429,{error:'Too many session requests. Please wait briefly.'});
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>runtime.max_request_bytes)return json(res,413,{error:'Request too large.'});}
      const input=JSON.parse(body), result=engine.create(input);
      res.setHeader('Set-Cookie',cookieValue(sessionCookie,result.access,{secure:deployment.secure,maxAge:policy.closure.session_ttl_hours*3600}));
      return json(res,201,{session:result.session,reply:result.reply});
    }catch(error){return json(res,400,{error:error.message==='Unexpected end of JSON input'?'Invalid request.':error.message});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  const wss=new WebSocketServer({noServer:true,maxPayload:runtime.max_payload_bytes,handleProtocols:protocols=>protocols.has('vaani')?'vaani':false});
  server.on('upgrade',(req,socket,head)=>{
    if(shuttingDown.value||!validHost(req)||!validOrigin(req)||req.url!=='/voice'||wss.clients.size>=runtime.max_connections){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return socket.destroy();}
    const protocols=(req.headers['sec-websocket-protocol']||'').split(',').map(p=>p.trim());
    const token=protocols.find(p=>p.startsWith('ticket.'))?.slice(7);
    const access=token?tickets.consume(token,req.headers.origin):(!deployment.secure?cookie(req):null);
    const session=store.authorize(access);
    if(!session||(token&&!protocols.includes('vaani'))){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return socket.destroy();}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,session.id,access));
  });
  wss.on('connection',(ws,sessionId,access)=>{
    let config=settings(),stt,started=false,textOnly=true,current,sequence=0,closed=false,muted=false,userTalking=false;
    let silenceCount=0,pending=0,queue=Promise.resolve(),classifierController;
    let rate={start:Date.now(),count:0},audioRate={start:Date.now(),bytes:0};
    const send=(type,data={})=>{if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<4*runtime.max_payload_bytes)ws.send(JSON.stringify({type,...data}));else if(ws.bufferedAmount>=4*runtime.max_payload_bytes)ws.close(1013,'Playback client is too slow.');};
    const fail=message=>send('error',{message});
    const cancel=()=>{classifierController?.abort();classifierController=null;if(!current)return;const old=current;current=null;old.controller.abort();send('interrupted',{turn:old.id});};
    async function speakReply(reply){
      cancel();if(closed||reply.silent)return;
      const turn={id:++sequence,controller:new AbortController(),started:performance.now()};current=turn;
      const valid=()=>!closed&&current===turn;
      send('turn_start',{turn:turn.id});send('assistant_delta',{text:reply.text,turn:turn.id});
      if(!voiceAvailable){send('turn_done',{turn:turn.id,text:reply.text,audio:false});return;}
      let first=true;const timeout=setTimeout(()=>{if(valid()){fail('Voice response timed out. The written response and any confirmed action remain saved.');cancel();}},runtime.provider_reply_timeout_ms);
      try{
        const tts=providers.speechStream({key:credentials.sarvam,model:ttsModel,config,language:/[\u0900-\u097f]/.test(reply.text)?'hi-IN':'en-IN',signal:turn.controller.signal,onAudio:data=>{if(!valid())return;if(first){first=false;send('latency',{turn:turn.id,ms:Math.round(performance.now()-turn.started)});}send('audio',{...data,turn:turn.id});}});
        for(const sentence of takeSentences(reply.text,true).chunks)tts.push(cleanSpeech(sentence));
        const result=await tts.end();if(!result.audioCount)throw new Error('No voice audio was received.');
        if(valid())send('turn_done',{turn:turn.id,text:reply.text,audio:true});
      }catch(error){if(valid()&&error.name!=='AbortError'){fail('Voice playback is unavailable. The written response and session are saved; you can continue in chat.');send('turn_done',{turn:turn.id,text:reply.text,audio:false});}}
      finally{clearTimeout(timeout);}
    }
    function acceptMessage(input){
      if(pending>=runtime.max_pending_messages){fail('Please wait for the current message to finish.');return;}
      cancel();silenceCount=0;pending++;
      queue=queue.then(async()=>{
        if(closed||shuttingDown.value)return;
        const s=store.authorize(access);if(!s){ws.close(1008,'Session expired.');return;}
        try{
          let fallback;
          if(!input.action&&canUseModel(s)&&classify(input.text,s).intent==='other'&&credentials.ollama){
            classifierController=new AbortController();
            try{fallback=await providers.classifyWithModel({key:credentials.ollama,model,text:redact(input.text),context:classifierContext(s),signal:classifierController.signal});}
            catch{if(!closed&&!shuttingDown.value)store.audit(sessionId,'GUARDRAIL',{rule:'classifier_unavailable',fallback:'deterministic_clarification'});}
            finally{classifierController=null;}
          }
          if(closed||shuttingDown.value)return;
          const result=engine.handle(sessionId,{...input,fallback});
          send('session',{session:result.session});
          if(result.duplicate)return;
          const actionLabels={close_card:'Close the card',confirm_closure:'Confirm simulated closure',accept_offer:'Accept demo offer',decline_offer:'Decline and close',redeem_points:'Redeem demo points',skip:'Skip this step',resume_closure:'Continue closure',select_identity:'Confirm matched demo profile',confirm_identity:'Confirm my profile',register_profile:'Create a synthetic profile',save_profile:'Save profile',cancel_registration:'Cancel registration',security_support:'Help with the lost card',security_close:'Continue permanent account closure'};
          send('user_text',{text:redact(input.text||actionLabels[input.action]||input.action)});
          void speakReply(result.reply);
        }catch(error){if(!closed&&!shuttingDown.value){fail(error.message);const latest=store.get(sessionId);if(latest)send('session',{session:engine.view(latest)});}}
      }).catch(()=>{if(!closed&&!shuttingDown.value)fail('This message could not be processed. Reconnect to the saved session.');}).finally(()=>{pending--;});
    }
    const initialize=message=>{
      if(started)return;started=true;clearTimeout(connectTimeout);textOnly=Boolean(message.textOnly);config=settings(message);
      const session=engine.resume(sessionId);
      const willSpeak=!textOnly&&session.revision<=1&&message.newSession;
      const ready=()=>{send('ready',{textOnly,session,willSpeak,voiceAvailable});if(willSpeak){const last=session.transcript.at(-1);if(last?.role==='assistant')void speakReply({text:last.text});}};
      if(textOnly){ready();return;}
      if(!voiceAvailable){fail('Sarvam credentials are missing. Chat still works.');ws.close();return;}
      if(['BLOCKED','CLOSED','STOPPED'].includes(session.state)){ready();return;}
      stt=providers.connectRecognition({key:credentials.sarvam,model:sttModel,onEvent:event=>{
        if(closed)return;
        if(event.event==='session.begin')ready();
        else if(event.event==='vad.speech_start'&&!muted){userTalking=true;cancel();send('listening');}
        else if(event.event==='vad.speech_end')userTalking=false;
        else if(event.event==='transcript.partial'&&!muted)send('partial',{text:redact(event.text)});
        else if(event.event==='transcript.final'&&!muted&&event.text?.trim()){
          userTalking=false;
          // Saaras realtime does not provide transcript confidence. Never substitute language confidence.
          acceptMessage({text:event.text.trim(),channel:'voice',confidence:null,messageId:`voice-${sessionId}-${Date.now()}-${event.utterance_idx}`});
        }else if(event.event==='error'){fail('Speech recognition failed. Your session is saved; reconnect or use chat.');stt?.close();}
      },onError:()=>{fail('Speech recognition could not connect. Your session is saved.');ws.close();},onClose:()=>{if(!closed){fail('Speech recognition disconnected. Resume this saved session to reconnect.');ws.close();}}});
    };
    ws.on('message',(data,binary)=>{
      if(binary){
        if(!started||textOnly)return;
        const now=Date.now();if(now-audioRate.start>=1000)audioRate={start:now,bytes:0};audioRate.bytes+=data.length;
        if(audioRate.bytes>runtime.audio_bytes_per_second||data.length%2){ws.close(1008,'Invalid audio rate or format.');return;}
        if(!muted&&stt?.readyState===WebSocket.OPEN)stt.send(JSON.stringify({event:'audio_input',audio:data.toString('base64')}));return;
      }
      try{
        const now=Date.now();if(now-rate.start>=runtime.message_window_ms)rate={start:now,count:0};
        const m=JSON.parse(data.toString());
        if(!m||typeof m!=='object')throw new Error('Invalid message.');
        if(m.type==='start')return initialize(m);
        if(!started)throw new Error('Start the session before sending messages.');
        if(m.type==='text'||m.type==='action'){
          if(++rate.count>runtime.messages_per_window)throw new Error('Please slow down before sending another message.');
          if(m.type==='text'&&(typeof m.text!=='string'||!m.text.trim()||m.text.length>runtime.max_message_characters))throw new Error('Enter a message within the character limit.');
          // Channel, recognition confidence, identity, policy and customer data are never accepted from the browser.
          acceptMessage({text:m.type==='text'?m.text:undefined,action:m.type==='action'?m.action:undefined,choice:m.choice,token:m.token,expectedRevision:m.expectedRevision,messageId:m.messageId,channel:'chat'});
        }else if(m.type==='interrupt')cancel();
        else if(m.type==='played'&&current?.id===m.turn)current=null;
        else if(m.type==='mute'){muted=Boolean(m.muted);userTalking=false;}
        else if(m.type==='silence'&&!textOnly&&!current&&!userTalking&&!muted&&silenceCount<2){
          const s=store.get(sessionId);if(['CLOSED','HANDOFF','STOPPED','BLOCKED'].includes(s.state))return;
          silenceCount++;void speakReply({text:s.language==='hi-IN'?(silenceCount===1?'आराम से, मैं यहीं हूँ।':'क्या आप अभी भी लाइन पर हैं?'):(silenceCount===1?'Take your time, I’m here.':'Are you still with me?')});
        }else if(m.type==='end')ws.close();
      }catch(error){fail(error.message==='Unexpected end of JSON input'?'Invalid message format.':error.message);}
    });
    const connectTimeout=setTimeout(()=>ws.close(1008,'Session start timed out.'),runtime.idle_connect_timeout_ms);
    let alive=true;ws.on('pong',()=>{alive=true;});
    const ping=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();if(stt?.readyState===WebSocket.OPEN)stt.send(JSON.stringify({event:'ping'}));},runtime.keepalive_ms);
    const maximum=setTimeout(()=>{fail('This call reached the demo duration limit. Your session is saved and can be resumed.');ws.close();},runtime.max_session_minutes*60000);
    ws.on('error',()=>{});
    ws.on('close',()=>{closed=true;cancel();clearTimeout(connectTimeout);clearTimeout(maximum);clearInterval(ping);stt?.close();});
  });
  async function shutdown(){
    shuttingDown.value=true;
    clearInterval(deadlineScanner);
    for(const client of wss.clients)client.close(1001,'Server restarting. Session saved.');
    await new Promise(resolve=>{const timer=setTimeout(()=>{for(const client of wss.clients)client.terminate();resolve();},runtime.shutdown_grace_ms);timer.unref();server.close(()=>{clearTimeout(timer);resolve();});});
    store.close();
  }
  return {server,wss,store,engine,shutdown,deployment};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.umask(0o077);
  let credentials={sarvam:process.env.SARVAM_API_KEY,ollama:process.env.OLLAMA_API_KEY};
  if(process.argv.includes('--stdin-credentials')){
    console.log('Ready for credentials on stdin (hidden).');const rl=readline.createInterface({input:process.stdin,terminal:false});
    credentials=JSON.parse(await new Promise(resolve=>rl.once('line',resolve)));rl.close();
  }
  const app=createApplication({credentials});
  const port=Number(process.env.PORT||runtime.port);
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Stop the existing app or select a different PORT.`:'Local server could not start.');app.store.close();process.exitCode=1;});
  app.server.listen(port,app.deployment.host,()=>console.log(`Vaani demo: ${app.deployment.backendOrigin||`http://localhost:${port}`} · persistent synthetic sessions · voice ${credentials.sarvam?'configured':'not configured'}`));
  let ending=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(ending)return;ending=true;await app.shutdown();process.exit(0);});
}
