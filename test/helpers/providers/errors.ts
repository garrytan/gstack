export interface ProviderProcessError {
  stderr?: Buffer | string;
  message?: string;
}

/** Combine subprocess diagnostics without duplicating identical text. */
export function providerErrorDetail(error: ProviderProcessError): string {
  const stderr = typeof error.stderr === 'string'
    ? error.stderr
    : error.stderr?.toString() ?? '';
  const message = error.message ?? '';
  return stderr && message.includes(stderr)
    ? message
    : [stderr, message].filter(Boolean).join('\n');
}

/** Provider/model saturation is transient and distinct from auth or quota. */
export function isCapacityError(detail: string): boolean {
  return /(?:selected\s+)?model\s+is\s+at\s+capacity|\bat\s+capacity\b|\bmodel\s+capacity\b|\boverloaded\b|temporarily unavailable due to (?:high )?(?:load|demand)/i.test(detail);
}
