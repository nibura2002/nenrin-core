// Canonical JSON serialization (simplified JCS: sorted keys, no whitespace).
// PoC note: payloads must contain only integers/strings/bools to avoid float
// serialization edge cases. Production record-core should use RFC 8785 or CBOR.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
