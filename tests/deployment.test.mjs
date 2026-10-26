import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import WebSocket from 'ws';
import {loadDeployment,httpsOrigin} from '../lib/deployment.mjs';
import {VoiceTickets} from '../lib/transport-auth.mjs';
import {buildFrontend} from '../scripts/build-frontend.mjs';
import {createApplication} from '../server.mjs';
import {Store} from '../lib/store.mjs';

const env={DEPLOYMENT_TARGET:'render',PUBLIC_BACKEND_URL:'https://vaani-api.example',FRONTEND_ORIGINS:'https://vaani.example',DATABASE_PATH:'/var/data/vaani/aria.sqlite'};
test('hosted deployment requires explicit origins and an absolute database path',()=>{
  const config=loadDeployment(env);assert.equal(config.host,'0.0.0.0');assert.equal(config.secure,true);assert.equal('accessCode' in config,false);
  for(const key of ['FRONTEND_ORIGINS','PUBLIC_BACKEND_URL','DATABASE_PATH'])assert.throws(()=>loadDeployment({...env,[key]:''}));
  for(const value of ['http://api.example','https://user:pass@api.example','https://api.example/path','https://api.example/?key=secret','https://*.vercel.app']){
    if(value.includes('*'))assert.throws(()=>loadDeployment({...env,FRONTEND_ORIGINS:value}));else assert.throws(()=>httpsOrigin(value));
  }
  assert.equal(loadDeployment({}).host,'127.0.0.1');assert.throws(()=>loadDeployment({DEPLOYMENT_TARGET:'anything'}));
});
test('voice tickets are origin-bound, expire and cannot be replayed',()=>{
  let now=0;const tickets=new VoiceTickets(()=>now),token=tickets.issue('session-secret','https://vaani.example');
  assert.equal(tickets.consume(token,'https://evil.example'),null);
  assert.equal(tickets.consume(token,'https://vaani.example'),'session-secret');assert.equal(tickets.consume(token,'https://vaani.example'),null);
  const old=tickets.issue('other','https://vaani.example');now=60001;assert.equal(tickets.consume(old,'https://vaani.example'),null);
});
test('the supplied project URLs are allowed only on their configured backend, with exact origin matching',()=>{
  const project=loadDeployment({...env,PUBLIC_BACKEND_URL:'https://vaani-backend-vv52.onrender.com',FRONTEND_ORIGINS:'https://vaani-backend-vv52.onrender.com'});
  assert.deepEqual(project.frontendOrigins,['https://vaani-backend-vv52.onrender.com','https://vaaniai-git-main-meet547s-projects.vercel.app']);
  assert.equal(project.frontendOrigins.includes('https://unrelated.vercel.app'),false);
  assert.deepEqual(loadDeployment(env).frontendOrigins,['https://vaani.example']);
  assert.throws(()=>loadDeployment({...env,PUBLIC_BACKEND_URL:'https://vaani-backend-vv52.onrender.com',FRONTEND_ORIGINS:'https://*.vercel.app'}));
});
test('Vercel build publishes only frontend assets, proxies API requests and allows direct secure voice',async t=>{
  const outputDirectory=await mkdtemp(join(tmpdir(),'vaani-build-'));t.after(()=>rm(outputDirectory,{recursive:true,force:true}));
  const config=await buildFrontend({backendUrl:env.PUBLIC_BACKEND_URL,outputDirectory});
  assert.equal(config.version,3);assert.equal(config.routes.find(r=>r.src==='/api/(.*)').dest,'https://vaani-api.example/api/$1');
  const headers=config.routes[0].headers;assert.match(headers['Content-Security-Policy'],/wss:\/\/vaani-api.example/);assert.equal(headers['Cache-Control'],'no-store');
  assert.deepEqual((await readdir(join(outputDirectory,'static'))).sort(),['app.js','conversation.css','demo-backup.wav','index.html','mic-worklet.js','style.css']);
  const built=await readFile(join(outputDirectory,'config.json'),'utf8');assert.ok(!built.includes('API_KEY'));
  assert.doesNotMatch(await readFile(join(outputDirectory,'static','index.html'),'utf8'),/access-panel|access-code/);
  assert.doesNotMatch(await readFile(join(outputDirectory,'static','app.js'),'utf8'),/\/api\/access|access-form/);
  await assert.rejects(()=>buildFrontend({backendUrl:'https://unsafe.example/path',outputDirectory}));
  const configured=await buildFrontend({backendUrl:'',outputDirectory});
  assert.equal(configured.routes[1].dest,'https://vaani-backend-vv52.onrender.com/api/$1');
  await assert.rejects(()=>buildFrontend({backendUrl:'[https://broken.example/](https://broken.example/)',outputDirectory}),/Set BACKEND_URL on Vercel/);
  assert.equal(JSON.parse(await readFile(join(outputDirectory,'config.json'),'utf8')).routes[1].dest,configured.routes[1].dest);
});
test('public hosted API, secure session cookies and ticket-authenticated WebSocket work together',async t=>{
  // Model the proxy's upstream Host explicitly; browser fetch owns its Host header.
  const fetch=(url,options={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(url,{method:options.method||'GET',headers:options.headers},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,headers:{get:key=>{const value=res.headers[key.toLowerCase()];return Array.isArray(value)?value.join(', '):value;}},json:async()=>JSON.parse(body)}));
    });req.on('error',reject);req.end(options.body);
  });
  const app=createApplication({deployment:loadDeployment(env),store:new Store(':memory:')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.shutdown());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const headers={Host:'vaani-api.example',Origin:'https://vaani.example','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/health',{headers})).status,200);
  assert.equal((await fetch(base+'/api/config',{headers})).status,200);
  assert.equal((await fetch(base+'/api/access',{headers})).status,404);
  assert.equal((await fetch(base+'/api/access',{method:'POST',headers,body:'{}'})).status,405);
  assert.equal((await fetch(base+'/api/session',{headers})).status,401);
  assert.equal((await fetch(base+'/api/sessions',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  const created=await fetch(base+'/api/sessions',{method:'POST',headers,body:JSON.stringify({customerId:'H-CARD-1'})});assert.equal(created.status,201);
  assert.match(created.headers.get('set-cookie'),/^__Host-vaani_session=.*; Secure$/);
  headers.Cookie=created.headers.get('set-cookie').split(';')[0];const session=(await created.json()).session;
  assert.equal((await fetch(base+'/api/session',{headers}).then(r=>r.json())).session.id,session.id);
  assert.equal((await fetch(base+'/api/voice-ticket',{method:'POST',headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const connection=await fetch(base+'/api/voice-ticket',{method:'POST',headers}).then(r=>r.json());assert.equal(connection.url,'wss://vaani-api.example/voice');
  const socket=new WebSocket(base.replace('http','ws')+'/voice',['vaani',`ticket.${connection.ticket}`],{origin:headers.Origin,headers:{Host:headers.Host}});
  t.after(()=>socket.close());await once(socket,'open');assert.equal(socket.protocol,'vaani');
  const ready=once(socket,'message');socket.send(JSON.stringify({type:'start',textOnly:true}));assert.equal(JSON.parse((await ready)[0]).type,'ready');
  const replay=new WebSocket(base.replace('http','ws')+'/voice',['vaani',`ticket.${connection.ticket}`],{origin:headers.Origin,headers:{Host:headers.Host}});
  assert.match((await once(replay,'error'))[0].message,/403/);
  const cookieOnly=new WebSocket(base.replace('http','ws')+'/voice',{origin:headers.Origin,headers:{Host:headers.Host,Cookie:headers.Cookie}});
  assert.match((await once(cookieOnly,'error'))[0].message,/403/);
  assert.equal((await fetch(base+'/api/config',{headers:{...headers,Host:'evil.example'}})).status,403);
});
