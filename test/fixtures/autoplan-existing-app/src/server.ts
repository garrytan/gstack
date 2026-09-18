import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import index from '../index.html';
import { sessionUser, tokenHash } from './auth';

const sql = new SQL(process.env.DATABASE_URL!);
Bun.serve({
  routes: { '/': index, '/login': index, '/workspace': index },
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (request.headers.get('origin') !== process.env.APP_ORIGIN) return new Response('Forbidden', { status: 403 });
      const input = await request.json().catch(() => null);
      if (typeof input?.email !== 'string' || typeof input?.password !== 'string') return new Response('Bad request', { status: 400 });
      const [user] = await sql`SELECT id, password_hash FROM users WHERE email = ${input.email}`;
      if (!user || !await Bun.password.verify(input.password, user.password_hash)) return new Response('Invalid credentials', { status: 401 });
      const token = randomBytes(32).toString('hex');
      await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${tokenHash(token)}, ${user.id}, ${Date.now() + 3600000})`;
      return Response.json({ redirect: '/workspace' }, { headers: { 'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600` } });
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      const userId = await sessionUser(request, async hash => (await sql`SELECT user_id, expires_at FROM sessions WHERE token_hash = ${hash}`)[0]);
      return userId ? Response.json({ userId }) : new Response('Unauthorized', { status: 401 });
    }
    return new Response('Not found', { status: 404 });
  },
});
