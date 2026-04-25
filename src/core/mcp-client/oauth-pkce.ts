/**
 * PKCE (RFC 7636) helpers for the MCP OAuth 2.1 client.
 *
 * S256 only — OAuth 2.1 §7.5.2 forbids `plain`. We mirror the exact base64url
 * conventions used by our AS (`src/mcp/oauth-helpers.ts::pkceVerifies`) so a
 * self-test against wikimem's own server always round-trips cleanly.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  /** `code_verifier` kept by the client until the token exchange. */
  verifier: string;
  /** `code_challenge` sent on the `/authorize` request. */
  challenge: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Generate a fresh PKCE pair. 32 bytes = 43-char verifier, well within spec. */
export function generatePkce(): PkcePair {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

/** Cryptographically strong state parameter for CSRF defense. */
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Canonicalize an MCP server URL for use as the OAuth Resource Indicator
 * (RFC 8707) and as the cache key for token storage.
 *
 * Rules: lowercase scheme + host, no fragment, no trailing slash, preserve
 * pathname (so `/mcp` and `/v1/mcp` remain distinct audiences).
 */
export function canonicalizeResource(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  u.protocol = u.protocol.toLowerCase();
  let pathname = u.pathname;
  // Strip trailing slash from the path unless the path IS just "/"
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const search = u.search;
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${u.hostname}${port}${pathname}${search}`;
}
