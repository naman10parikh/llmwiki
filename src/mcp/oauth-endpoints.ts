/**
 * MCP OAuth 2.1 Endpoint Constants.
 *
 * Shared paths used by the Authorization Server metadata, Protected Resource
 * metadata, and the route wiring in src/web/server.ts. Anything that emits a
 * URL pointing at the wikimem OAuth surface MUST import from here so the two
 * .well-known documents stay in sync with the actual route handlers.
 */

/** Well-known endpoints (RFC 8414 + RFC 9728). */
export const WELL_KNOWN_PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource';
export const WELL_KNOWN_AUTHORIZATION_SERVER = '/.well-known/oauth-authorization-server';

/** OAuth endpoints (RFC 6749, 7591, 8414). */
export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_REGISTER_PATH = '/oauth/register';

/** MCP HTTP transport endpoint. */
export const MCP_PATH = '/mcp';

/** Scopes the AS advertises and wikimem enforces. */
export const WIKIMEM_SCOPES = ['read:wiki', 'write:wiki', 'admin'] as const;
export type WikimemScope = (typeof WIKIMEM_SCOPES)[number];

/** Supported response_type values (OAuth 2.1 drops implicit, leaves `code`). */
export const RESPONSE_TYPES_SUPPORTED = ['code'] as const;

/** Supported grant_type values. */
export const GRANT_TYPES_SUPPORTED = ['authorization_code', 'refresh_token'] as const;

/** PKCE methods advertised — S256 only per OAuth 2.1 §7.5.2. */
export const CODE_CHALLENGE_METHODS_SUPPORTED = ['S256'] as const;

/**
 * Token endpoint authentication methods.
 *
 * - `none` is for public clients using PKCE (the default for Claude.ai + local
 *   MCP CLIs).
 * - `client_secret_basic` is accepted for confidential clients that ever get
 *   registered with a secret — we don't issue secrets today, but we advertise
 *   both so downstream code can expand without changing the AS metadata.
 */
export const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = [
  'none',
  'client_secret_basic',
] as const;

/** Bearer methods we accept (RFC 6750). Header-only — no query strings. */
export const BEARER_METHODS_SUPPORTED = ['header'] as const;

/** Authorization code TTL (seconds). */
export const AUTHORIZATION_CODE_TTL_SECONDS = 600;

/** Access token TTL (seconds). */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** Refresh token TTL (seconds). */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Documentation URL advertised in the PRM. */
export const RESOURCE_DOCUMENTATION_URL = 'https://github.com/naman10parikh/wikimem';

/**
 * Canonical public URL for this wikimem instance.
 *
 * Prefers `WIKIMEM_PUBLIC_URL` (e.g. `https://wikimem.example.com` or a stable
 * ngrok URL), falls back to the request's host header, and finally to the
 * supplied default. Always returns a URL without a trailing slash.
 */
export function resolveCanonicalIssuer(
  requestHost: string | undefined,
  requestProto: string | undefined,
  fallback: string,
): string {
  const envUrl = process.env['WIKIMEM_PUBLIC_URL'];
  if (envUrl) return envUrl.replace(/\/+$/, '');

  if (requestHost) {
    const proto = requestProto ?? 'http';
    return `${proto}://${requestHost}`.replace(/\/+$/, '');
  }

  return fallback.replace(/\/+$/, '');
}

/** The canonical MCP resource URI (what tokens' `aud` claim must equal). */
export function resolveCanonicalResource(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}${MCP_PATH}`;
}
