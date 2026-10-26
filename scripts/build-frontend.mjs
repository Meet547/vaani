import {mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {httpsOrigin,securityHeaders} from '../lib/deployment.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildFrontend({backendUrl=process.env.BACKEND_URL,outputDirectory=join(root,'.vercel/output')}={}){
  const backend=httpsOrigin(backendUrl,'BACKEND_URL');
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
  await buildFrontend();console.log('Vaani frontend built in .vercel/output. API proxy and direct Render voice origin configured.');
}
