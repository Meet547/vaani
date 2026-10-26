import {mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {httpsOrigin,securityHeaders} from '../src/deployment.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildFrontend({backendUrl=process.env.BACKEND_URL,outputDirectory=join(root,'.vercel/output')}={}){
  const configured=JSON.parse(await readFile(join(root,'config/deployment.json'),'utf8'));
  let backend;
  try{backend=httpsOrigin(backendUrl?.trim()||configured.backendUrl,'BACKEND_URL');}
  catch{throw new Error('Set BACKEND_URL on Vercel to the Render HTTPS origin (for example https://vaani-backend-vv52.onrender.com), without /api, quotes or Markdown. Alternatively update backendUrl in config/deployment.json.');}
  await rm(outputDirectory,{recursive:true,force:true});
  const assets=join(outputDirectory,'static');await mkdir(assets,{recursive:true});
  for(const file of ['index.html','app.js','style.css','conversation.css','mic-worklet.js'])await copyFile(join(root,'public',file),join(assets,file));
  await copyFile(join(root,'artifacts/aria-backup.wav'),join(assets,'demo-backup.wav'));
  const config={version:3,routes:[
    {src:'/(.*)',headers:{...securityHeaders(backend),'Cache-Control':'no-store','Strict-Transport-Security':'max-age=31536000'},continue:true},
    {src:'/api/(.*)',dest:`${backend}/api/$1`},
    {src:'/',dest:'/index.html'},
    {handle:'filesystem'},
    {src:'/(.*)',status:404},
  ]};
  await writeFile(join(outputDirectory,'config.json'),JSON.stringify(config,null,2)+'\n');
  return config;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const config=await buildFrontend();console.log(`Vaani frontend built in .vercel/output. API backend: ${new URL(config.routes[1].dest).origin}`);}
  catch(error){console.error(`Frontend build failed: ${error.message}`);process.exitCode=1;}
}
