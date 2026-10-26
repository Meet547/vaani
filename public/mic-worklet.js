class MicProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; this.frame = new Int16Array(1600); this.offset = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Stateful interpolation preserves the phase across 128-frame worklet blocks.
    this.samples.push(...input);
    const ratio = sampleRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const i = Math.floor(this.position), fraction = this.position - i;
      const sample = Math.max(-1, Math.min(1, this.samples[i] * (1 - fraction) + this.samples[i + 1] * fraction));
      this.frame[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      this.position += ratio;
      if (this.offset === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(1600); this.offset = 0;
      }
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length);
    this.samples.splice(0, consumed); this.position -= consumed;
    return true;
  }
}
registerProcessor('aria-mic', MicProcessor);
