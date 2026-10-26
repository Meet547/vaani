import { randomBytes } from 'node:crypto';
import { digest } from './store.mjs';

export function readCookie(req,name){return (req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);}
export function cookieValue(name,value,{secure=false,maxAge=86400}={}){return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;}
export class VoiceTickets {
  constructor(clock=()=>Date.now()){this.clock=clock;this.entries=new Map();}
  issue(access,origin){
    for(const [hash,item] of this.entries)if(item.expires<=this.clock())this.entries.delete(hash);
    if(this.entries.size>=1000)throw new Error('Too many pending voice connections. Try again shortly.');
    const token=randomBytes(32).toString('base64url');
    this.entries.set(digest(token),{access,origin,expires:this.clock()+60000});return token;
  }
  consume(token,origin){
    if(typeof token!=='string'||!/^[\w-]{43}$/.test(token))return null;
    const hash=digest(token),item=this.entries.get(hash);
    if(!item||item.expires<=this.clock()){this.entries.delete(hash);return null;}
    if(item.origin!==origin)return null;
    this.entries.delete(hash);return item.access;
  }
}
