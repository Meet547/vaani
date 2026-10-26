// Sarvam's WAV stream sends one header, followed by raw PCM chunks.
// Decode the container once instead of treating each chunk as a separate WAV.
export class WavStream {
  pending = Buffer.alloc(0);
  inData = false;
  sampleRate = 24000;
  channels = 1;
  push(input) {
    this.pending = Buffer.concat([this.pending, input]);
    if (!this.inData) {
      if (this.pending.length < 12) return null;
      if (this.pending.toString('ascii', 0, 4) !== 'RIFF' || this.pending.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Voice provider returned an unsupported audio container.');
      let cursor = 12;
      while (cursor + 8 <= this.pending.length) {
        const type = this.pending.toString('ascii', cursor, cursor + 4);
        const length = this.pending.readUInt32LE(cursor + 4);
        if (type === 'data') { this.inData = true; this.pending = this.pending.subarray(cursor + 8); break; }
        if (cursor + 8 + length > this.pending.length) return null;
        if (type === 'fmt ') {
          if (length < 16 || this.pending.readUInt16LE(cursor + 8) !== 1 || this.pending.readUInt16LE(cursor + 22) !== 16) throw new Error('Voice playback requires sixteen-bit PCM audio.');
          this.channels = this.pending.readUInt16LE(cursor + 10);
          this.sampleRate = this.pending.readUInt32LE(cursor + 12);
          if (this.channels !== 1) throw new Error('Voice playback requires mono audio.');
        }
        cursor += 8 + length + length % 2;
      }
      if (!this.inData) return null;
    }
    const evenLength = this.pending.length - this.pending.length % 2;
    if (!evenLength) return null;
    const output = this.pending.subarray(0, evenLength); this.pending = this.pending.subarray(evenLength);
    return { audio: output.toString('base64'), content_type: 'audio/pcm', sample_rate: this.sampleRate };
  }
}
