/** Resolve an injectable clock and serialize it for durable runtime state. */
export function currentIsoTimestamp(now) {
  const current = now ? now() : new Date();
  return current.toISOString();
}
