import { createHash } from 'node:crypto';

export type Session = { user_id: string; expires_at: number };
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Only the server-issued cookie identifies a session; never accept a user ID
// supplied in the URL/body. Raw session tokens are not stored in the database.
export async function sessionUser(request: Request, lookup: (hash: string) => Promise<Session | undefined>, now = Date.now()): Promise<string | null> {
  const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];
  if (!token) return null;
  const session = await lookup(tokenHash(token));
  return session && session.expires_at > now ? session.user_id : null;
}
