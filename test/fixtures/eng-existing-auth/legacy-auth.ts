/** Existing application boundary. Admission already authenticates the identity
 * and binds it to the tenant; this internal refactor does not change admission. */
export type Identity = Readonly<{ tenantId: string; subjectId: string }>;
export const POLICIES = ['account', 'tenant', 'device', 'network', 'resource'] as const;
export type Policy = typeof POLICIES[number];
export type Session = { id: string; expiresAt: number };
export interface Platform {
  // Five independent, read-only policy verdicts for the same verified identity.
  // The existing client enforces a 500ms deadline on each call and rejects on
  // transport/protocol failure. No verdict supplies input to another policy.
  // A call may also throw before returning a Promise. Preserve the legacy
  // AuthFailure mapping and policy-order precedence for both failure forms.
  checkPolicy(identity: Identity, policy: Policy): Promise<boolean>;
  // The existing session service owns opaque IDs, one-hour expiry, revocation,
  // and storage. Renewal is an explicit caller action, never implicit here.
  issueSession(identity: Identity): Promise<Session>;
}
export class AuthFailure extends Error {
  constructor(readonly code: 'denied' | 'provider_unavailable' | 'session_unavailable', options?: ErrorOptions) {
    super(code, options);
  }
}

// Preserve public outcomes, failure ordering and the Platform adapter contracts.
// Current implementation: no shared memoization, automatic retries, cancellation
// or single-flight work. This describes today's code, not the refactor's design.
// The caller maps denied to 403 and dependency failures to 503.
export async function legacyAuthFlow(identity: Identity, platform: Platform): Promise<Session> {
  for (const policy of POLICIES) {
    let allowed: boolean;
    try { allowed = await platform.checkPolicy(identity, policy); }
    catch (cause) { throw new AuthFailure('provider_unavailable', { cause }); }
    if (!allowed) throw new AuthFailure('denied');
  }
  try { return await platform.issueSession(identity); }
  catch (cause) { throw new AuthFailure('session_unavailable', { cause }); }
}
