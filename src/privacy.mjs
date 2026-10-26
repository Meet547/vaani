export function redact(text) {
  return String(text)
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[redacted card number]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '[redacted PAN]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[redacted email]')
    .replace(/(?:\+91[ -]?)?\b[6-9]\d{9}\b/g, '[redacted phone]')
    .replace(/\b(otp|pin|cvv|password|passcode)\s*(?:is|:|=)?\s*[\w-]+/gi, '$1 [redacted]');
}
export function safeDetail(detail) {
  if (typeof detail === 'string') return redact(detail);
  if (Array.isArray(detail)) return detail.map(safeDetail);
  if (detail && typeof detail === 'object') return Object.fromEntries(Object.entries(detail).filter(([k])=>!/token|secret|api.?key/i.test(k)).map(([k,v])=>[k,safeDetail(v)]));
  return detail;
}
