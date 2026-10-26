import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { digest } from './store.mjs';

export function readCookie(req,name){return (req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);}
export function cookieValue(name,value,{secure=false,maxAge=86400}={}){return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;}
const equal=(a,b)=>{const x=Buffer.from(digest(a||'')),y=Buffer.from(digest(b||''));return timingSafeEqual(x,y);};

export class DemoAccess {
  constructor(code,clock=()=>Date.now()){this.code=code;this.clock=clock;}
  required(){return Boolean(this.code);}
  matches(code){return typeof code==='string'&&code.length<=256&&equal(this.code,code);}
  sign(payload){return createHmac('sha256',this.code).update(payload).digest('base64url');}
  issue(){const payload=`${this.clock()+86400000}.${randomBytes(16).toString('base64url')}`;return `${payload}.${this.sign(payload)}`;}
  valid(token){
    if(!this.required())return true;
    if(typeof token!=='string'||token.length>256)return false;
    const parts=token.split('.');if(parts.length!==3||!/^\d+$/.test(parts[0]))return false;
    const expires=Number(parts[0]);return expires>this.clock()&&expires<=this.clock()+86400000&&equal(parts[2],this.sign(parts.slice(0,2).join('.')));
  }
}

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
