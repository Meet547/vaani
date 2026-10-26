import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WavStream } from '../lib/audio.mjs';

// Supply a synthetic, mono 16 kHz PCM WAV fixture, never a private recording.
const fixture = process.argv[2];
if (!fixture) throw new Error('Usage: node scripts/voice-smoke.mjs /path/to/synthetic-16k-mono.wav');
const packet = new WavStream().push(await readFile(fixture));
assert.equal(packet.sample_rate, 16000);
const pcm = Buffer.from(packet.audio, 'base64');
const base='http://localhost:4317';
const sessionResponse=await fetch(`${base}/api/sessions`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({customerId:'H-CARD-1',channel:'voice'})});
assert.equal(sessionResponse.status,201);
const sessionCookie=sessionResponse.headers.get('set-cookie').split(';')[0];
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://localhost:4317/voice', { origin: base, headers:{Cookie:sessionCookie} });
  let firstTurn, interrupted = false, userText = '', reply = '', staleAudio = 0, phase = 'greeting';
  const timeout = setTimeout(() => { ws.close(); reject(new Error('Voice test timed out')); }, 40000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'start',newSession:true })));
  ws.on('message', async raw => {
    const m = JSON.parse(raw);
    if (m.type === 'turn_start') firstTurn ??= m.turn;
    if (m.type === 'audio' && phase === 'greeting') {
      phase = 'input'; ws.send(JSON.stringify({ type: 'interrupt' }));
      for (let i = 0; i < pcm.length && ws.readyState === WebSocket.OPEN; i += 3200) {
        ws.send(pcm.subarray(i, i + 3200)); await delay(100);
      }
      for (let i = 0; i < 18 && ws.readyState === WebSocket.OPEN; i++) { ws.send(Buffer.alloc(3200)); await delay(100); }
    } else if (m.type === 'interrupted') interrupted = true;
    else if (m.type === 'audio' && interrupted && m.turn === firstTurn) staleAudio++;
    else if (m.type === 'user_text') userText = m.text;
    else if (m.type === 'assistant_delta' && m.turn !== firstTurn) reply += m.text;
    else if (m.type === 'error') { clearTimeout(timeout); ws.close(); reject(new Error(m.message)); }
    else if (m.type === 'turn_done' && m.turn !== firstTurn) {
      clearTimeout(timeout); ws.close();
      try {
        assert.ok(interrupted); assert.equal(staleAudio, 0); assert.match(userText, /credit card/i); assert.ok(reply.length > 5);
        console.log(JSON.stringify({ result: 'PASS', interrupted, staleAudio, transcript: userText, reply })); resolve();
      } catch (error) { reject(error); }
    }
  });
  ws.on('error', reject);
});
