import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';

const projectDeployment=JSON.parse(readFileSync(new URL('../config/deployment.json',import.meta.url),'utf8'));

export function httpsOrigin(value, label='URL') {
  let url;try{url=new URL(value);}catch{throw new Error(`${label} must be an HTTPS origin.`);}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname.includes('*'))throw new Error(`${label} must be an exact HTTPS origin without a path, credentials, query or wildcard.`);
  return url.origin;
}

export function loadDeployment(env=process.env) {
  const target=env.DEPLOYMENT_TARGET||'local';
  if(!['local','render'].includes(target))throw new Error('DEPLOYMENT_TARGET must be local or render.');
  if(target==='local')return {target,host:'127.0.0.1',secure:false,backendOrigin:null,frontendOrigins:[],databasePath:env.DATABASE_PATH||null};
  const backendOrigin=httpsOrigin(env.PUBLIC_BACKEND_URL||env.RENDER_EXTERNAL_URL,'PUBLIC_BACKEND_URL');
  // These exact project origins apply only to the project's configured backend.
  // A different backend must supply its own allowlist through the environment.
  const projectOrigins=backendOrigin===httpsOrigin(projectDeployment.backendUrl,'config/deployment.json backendUrl')?(projectDeployment.frontendOrigins||[]):[];
  const frontendOrigins=[...projectOrigins,...(env.FRONTEND_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean)].map(s=>httpsOrigin(s,'FRONTEND_ORIGINS'));
  if(!frontendOrigins.length)throw new Error('Set FRONTEND_ORIGINS to the exact Vercel/custom frontend origin.');
  if(!env.DATABASE_PATH||!isAbsolute(env.DATABASE_PATH))throw new Error('Hosted demos require an absolute DATABASE_PATH on a persistent disk.');
  const backendHosts=[new URL(backendOrigin).host];
  if(env.RENDER_EXTERNAL_URL)backendHosts.push(new URL(httpsOrigin(env.RENDER_EXTERNAL_URL,'RENDER_EXTERNAL_URL')).host);
  return {target,host:'0.0.0.0',secure:true,backendOrigin,backendHosts:[...new Set(backendHosts)],frontendOrigins:[...new Set(frontendOrigins)],databasePath:env.DATABASE_PATH};
}

export function securityHeaders(backendOrigin=null) {
  const socket=backendOrigin?backendOrigin.replace(/^https:/,'wss:'):'';
  return {
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'${socket?' '+socket:''}; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'Permissions-Policy':'microphone=(self), camera=(), geolocation=()',
  };
}
