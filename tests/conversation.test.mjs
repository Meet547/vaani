import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { settings, takeSentences, cleanSpeech } from '../lib/conversation.mjs';

test('streamed sentences preserve an incomplete thought across token chunks', () => {
  const first = takeSentences('That sounds frustrating. What would');
  assert.deepEqual(first.chunks, ['That sounds frustrating.']);
  assert.deepEqual(takeSentences(first.rest + ' work better for you?').chunks, ['What would work better for you?']);
  assert.deepEqual(takeSentences('समझ सकती हूँ। आपकी क्या चिंता है?').chunks, ['समझ सकती हूँ।', 'आपकी क्या चिंता है?']);
  assert.deepEqual(takeSentences('An unfinished thought', true).chunks, ['An unfinished thought']);
});
test('client settings are bounded and speech markers are not spoken', () => {
  assert.deepEqual(settings({ voice: '__proto__', language: 'xx', pace: 100 }), { voice: 'warm', language: 'auto', pace: 1.15 });
  assert.equal(cleanSpeech('[CALL_START] **Hello.**'), 'Hello.');
});
test('microphone resampling preserves sample count and amplitude at 48k and 44.1k', () => {
  const code = readFileSync(new URL('../public/mic-worklet.js', import.meta.url), 'utf8');
  for (const rate of [48000, 44100]) {
    let Processor; const frames = [];
    const sandbox = { sampleRate: rate, AudioWorkletProcessor: class { port = { postMessage: buffer => frames.push(new Int16Array(buffer)) }; }, registerProcessor: (_, value) => { Processor = value; } };
    vm.runInNewContext(code, sandbox);
    const processor = new Processor();
    const blocks = Math.ceil(rate / 128);
    for (let i = 0; i < blocks; i++) processor.process([[new Float32Array(128).fill(0.25)]]);
    assert.equal(frames.length, 10);
    const samples = frames.length * 1600 + processor.offset;
    assert.ok(Math.abs(samples - blocks * 128 * 16000 / rate) <= 1, 'Resampling must not accumulate phase drift across worklet blocks');
    assert.equal(frames[0][0], 8192);
  }
});
