import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeDetail } from './privacy.mjs';
export const digest = input => createHash('sha256').update(input).digest('hex');

export class Store {
  constructor(path='data/aria.sqlite') {
    if(path!==':memory:') { mkdirSync(dirname(path),{recursive:true,mode:0o700}); chmodSync(dirname(path),0o700); }
    this.db = new DatabaseSync(path);
    if(path!==':memory:') chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>2) throw new Error('Database schema is newer than this app.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, access_hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), snapshot TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS closures (id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id), customer_id TEXT NOT NULL, reference TEXT UNIQUE NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), action_id TEXT NOT NULL, terms TEXT NOT NULL, UNIQUE(session_id, action_id));
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), queue TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL, summary TEXT NOT NULL, UNIQUE(session_id, queue));
      CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL REFERENCES sessions(id), message_id TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session_id,message_id));
      CREATE TABLE IF NOT EXISTS deadline_alerts (key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), detail TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_profiles (id TEXT PRIMARY KEY, name_key TEXT NOT NULL, city_key TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(name_key,city_key));
      PRAGMA user_version=2;
    `);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;} }
  createSession(data, expires) {
    const id=randomUUID(), access=randomBytes(32).toString('base64url');
    const session={...data,id,revision:0};
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,digest(access),expires,JSON.stringify(session));
    return {session,access};
  }
  authorize(access,now=Date.now()) { if(!access)return null; const row=this.db.prepare('SELECT data FROM sessions WHERE access_hash=? AND expires>?').get(digest(access),now); return row?JSON.parse(row.data):null; }
  get(id) {const row=this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
  save(session) {this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session),session.id);}
  profiles(){return this.db.prepare('SELECT data FROM customer_profiles ORDER BY created,id').all().map(row=>JSON.parse(row.data));}
  saveProfile(profile,nameKey,cityKey,now=Date.now()){
    const existing=this.db.prepare('SELECT data FROM customer_profiles WHERE name_key=? AND city_key=?').get(nameKey,cityKey);
    if(existing)return JSON.parse(existing.data);
    this.db.prepare('INSERT INTO customer_profiles VALUES(?,?,?,?,?)').run(profile.id,nameKey,cityKey,JSON.stringify(profile),now);return profile;
  }
  audit(id,kind,detail,now=Date.now()) {
    const previous=this.db.prepare('SELECT hash FROM audit_log WHERE session_id=? ORDER BY id DESC LIMIT 1').get(id)?.hash||'';
    const payload=JSON.stringify(safeDetail(detail));
    const hash=digest(`${previous}|${id}|${now}|${kind}|${payload}`);
    this.db.prepare('INSERT INTO audit_log(session_id,ts,kind,detail,previous_hash,hash) VALUES(?,?,?,?,?,?)').run(id,now,kind,payload,previous,hash);
  }
  trace(id,limit=null) {const rows=limit?this.db.prepare('SELECT ts,kind,detail,previous_hash,hash FROM audit_log WHERE session_id=? ORDER BY id DESC LIMIT ?').all(id,limit).reverse():this.db.prepare('SELECT ts,kind,detail,previous_hash,hash FROM audit_log WHERE session_id=? ORDER BY id').all(id);return rows.map(row=>({...row,detail:JSON.parse(row.detail)}));}
  verifyAudit(id) { let previous='';for(const row of this.db.prepare('SELECT * FROM audit_log WHERE session_id=? ORDER BY id').all(id)){if(row.previous_hash!==previous||row.hash!==digest(`${previous}|${id}|${row.ts}|${row.kind}|${row.detail}`))return false;previous=row.hash;}return true; }
  close(){this.db.close();}
}
