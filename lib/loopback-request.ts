/**
 * Request checks for daemons bound to a loopback port. Binding 127.0.0.1
 * keeps other machines out but not other origins on this machine: a browser
 * page can send requests to the port, and a page served under a hostname
 * that resolves to 127.0.0.1 arrives with that hostname as Host. Serving
 * only loopback Host values and same-origin (or absent) Origin values keeps
 * the port to local clients that address it directly.
 */

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

function isLoopbackAuthority(authority: string, port: number): boolean {
  const normalized = authority.toLowerCase();
  return LOOPBACK_HOSTNAMES.some((hostname) => normalized === `${hostname}:${port}`);
}

/** Why a request to a loopback daemon on `port` must be refused, or null to serve it. */
export function loopbackRequestRefusal(
  host: string | null | undefined,
  origin: string | null | undefined,
  port: number,
): 'host_not_loopback' | 'cross_origin' | null {
  if (!host || !isLoopbackAuthority(host, port)) return 'host_not_loopback';
  if (origin === null || origin === undefined) return null;
  if (!origin.startsWith('http://') || !isLoopbackAuthority(origin.slice('http://'.length), port)) return 'cross_origin';
  return null;
}
