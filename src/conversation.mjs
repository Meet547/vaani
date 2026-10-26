export const voices = {
  warm: { label: 'Simran · warm & conversational', speaker: 'simran_enhi_customer' },
  expressive: { label: 'Ishita · expressive & attentive', speaker: 'ishita_enhi_customer_expressive' },
  calm: { label: 'Shalini · calm & reassuring', speaker: 'shalini_enhi_customer' },
};
export function settings(input = {}) {
  return {
    voice: Object.hasOwn(voices, input.voice) ? input.voice : 'warm',
    language: ['auto', 'en-IN', 'hi-IN'].includes(input.language) ? input.language : 'auto',
    pace: Math.max(0.85, Math.min(1.15, Number(input.pace) || 1)),
  };
}
// Only complete sentences enter the speech stream; the remainder is retained.
export function takeSentences(buffer, final = false) {
  const chunks = [];
  let match;
  while ((match = buffer.match(/^([\s\S]*?[.!?।])(?:\s+|$)/))) {
    chunks.push(match[1].trim());
    buffer = buffer.slice(match[0].length);
  }
  if (final && buffer.trim()) { chunks.push(buffer.trim()); buffer = ''; }
  return { chunks: chunks.filter(Boolean), rest: buffer };
}

export function cleanSpeech(text) {
  return text.replace(/\[(?:INTERRUPTED|SILENCE|UNCLEAR|CALL_START)\]/g, '')
    .replace(/<[^>]*>/g, '').replace(/[*#`]/g, '').trim();
}
