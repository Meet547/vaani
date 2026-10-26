import WebSocket from 'ws';
import assert from 'node:assert/strict';
const base = 'http://localhost:4317';
const config = await fetch(`${base}/api/config`).then(r => r.json());
assert.equal(config.configured, true);
assert.equal((await fetch(`${base}/.env`)).status, 404);
const sessionResponse=await fetch(`${base}/api/sessions`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({customerId:'H-CARD-1',channel:'chat'})});
assert.equal(sessionResponse.status,201);
const sessionCookie=sessionResponse.headers.get('set-cookie').split(';')[0];
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://localhost:4317/voice', { origin: base, headers:{Cookie:sessionCookie} });
  const timeout = setTimeout(() => { ws.close(); reject(new Error('Smoke test timed out')); }, 40000);
  let text = '', count = 0, firstAudio, start;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'start', textOnly: true })));
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'ready') { start = Date.now(); ws.send(JSON.stringify({ type: 'text', text: 'I want to close my card because the annual fee is too high.' })); }
    if (message.type === 'assistant_delta') text += message.text;
    if (message.type === 'audio') {
      count++; firstAudio ??= Date.now() - start;
      const audio = Buffer.from(message.audio, 'base64');
      assert.equal(message.content_type, 'audio/pcm');
      assert.equal(message.sample_rate, 24000);
      assert.equal(audio.length % 2, 0);
      assert.ok(audio.length > 0);
    }
    if (message.type === 'error') { clearTimeout(timeout); ws.close(); reject(new Error(message.message)); }
    if (message.type === 'turn_done') {
      clearTimeout(timeout); assert.ok(count > 0); assert.ok(text.length > 10);
      console.log(JSON.stringify({ result: 'PASS', firstAudioMs: firstAudio, pcmChunks: count, reply: text })); ws.close(); resolve();
    }
  });
  ws.on('error', reject);
});
