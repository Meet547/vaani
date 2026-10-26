import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WavStream } from '../src/audio.mjs';

function header() {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(0xffffffff, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0xffffffff, 40);
  return b;
}
test('WAV demux buffers fragmented headers and odd PCM bytes without losing samples', () => {
  const wav = new WavStream(), h = header();
  assert.equal(wav.push(h.subarray(0, 17)), null);
  assert.equal(wav.push(h.subarray(17)), null);
  assert.equal(wav.push(Buffer.from([1])), null);
  assert.deepEqual(wav.push(Buffer.from([2, 3, 4, 5])), { audio: Buffer.from([1,2,3,4]).toString('base64'), content_type: 'audio/pcm', sample_rate: 24000 });
  assert.equal(wav.push(Buffer.from([6])).audio, Buffer.from([5,6]).toString('base64'));
});
test('WAV demux handles a complete first packet and rejects unsupported formats', () => {
  const wav = new WavStream();
  assert.equal(wav.push(Buffer.concat([header(), Buffer.from([1,2])])).audio, 'AQI=');
  const invalid = header(); invalid.writeUInt16LE(3, 20);
  assert.throws(() => new WavStream().push(invalid), /PCM/);
});
