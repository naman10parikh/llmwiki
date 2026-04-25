/**
 * MCP metadata discovery: the 401-probe → PRM → ASM chain.
 *
 * Implements the canonical MCP 2025-06-18 discovery flow a client uses when
 * it has nothing but an MCP server URL:
 *
 *   1. Unauthed `POST <mcpUrl>` → expect HTTP 401 with `WWW-Authenticate`
 *   2. Parse `resource_metadata="..."` from that header
 *   3. `GET <resource_metadata_url>` → RFC 9728 Protected Resource Metadata
 *   4. Pick first entry from `authorization_servers`
 *   5. `GET <as>/.well-known/oauth-authorization-server` → RFC 8414 ASM
 *
 * All three steps return normalized shapes with only the fields we need, so
 * callers (client.ts, tests) don't have to chase spec vocabulary.
 */

import { canonicalizeResource } from './oauth-pkce.js';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported: string[];
  grant_types_supported: string[];
  response_types_supported: string[];
  scopes_supported?: string[];
}

export interface DiscoveryResult {
  mcpUrl: string;
  canonicalResource: string;
  prm: ProtectedResourceMetadata;
  asm: AuthorizationServerMetadata;
}

/**
 * Parse `resource_metadata=...` from a WWW-Authenticate challenge header.
 *
 * The spec allows either a quoted or unquoted value. We tolerate both.
 * Returns `null` if the header is missing or doesn't contain the attribute.
 */
export function parseResourceMetadataFromChallenge(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  // Match resource_metadata="..." OR resource_metadata=<token>
  const quoted = /resource_metadata="([^"]+)"/i.exec(header);
  if (quoted && quoted[1]) return quoted[1];
  const unquoted = /resource_metadata=([^\s,]+)/i.exec(header);
  if (unquoted && unquoted[1]) return unquoted[1];
  return null;
}

/**
 * Step 1+2: probe the MCP endpoint unauthed and extract the PRM URL from the
 * 401 response's WWW-Authenticate header.
 */
export async function probeForResourceMetadata(mcpUrl: string): Promise<string> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
  });

  if (res.status !== 401) {
    // Some servers might return the PRM URL in a body instead — try that.
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body['resource_metadata'] === 'string') {
        return body['resource_metadata'] as string;
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      `Expected 401 from unauthed MCP probe, got ${res.status}. The target may not implement MCP 2025-06-18 OAuth 2.1.`,
    );
  }

  const wwwAuth = res.headers.get('www-authenticate');
  const prmUrl = parseResourceMetadataFromChallenge(wwwAuth);
  if (prmUrl) return prmUrl;

  // Body-fallback path (some servers mirror the PRM pointer in JSON).
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body['resource_metadata'] === 'string') {
      return body['resource_metadata'] as string;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    `401 from ${mcpUrl} did not include a resource_metadata pointer. WWW-Authenticate: ${wwwAuth ?? '(missing)'}`,
  );
}

/** Step 3: fetch Protected Resource Metadata (RFC 9728). */
export async function fetchProtectedResourceMetadata(
  prmUrl: string,
): Promise<ProtectedResourceMetadata> {
  const res = await fetch(prmUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`PRM fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const resource = body['resource'];
  const servers = body['authorization_servers'];
  if (typeof resource !== 'string' || !Array.isArray(servers) || servers.length === 0) {
    throw new Error('PRM missing required resource/authorization_servers fields');
  }
  return {
    resource,
    authorization_servers: servers.map(String),
    scopes_supported: Array.isArray(body['scopes_supported'])
      ? (body['scopes_supported'] as unknown[]).map(String)
      : [],
    bearer_methods_supported: Array.isArray(body['bearer_methods_supported'])
      ? (body['bearer_methods_supported'] as unknown[]).map(String)
      : ['header'],
  };
}

/** Step 5: fetch Authorization Server Metadata (RFC 8414). */
export async function fetchAuthorizationServerMetadata(
  asIssuer: string,
): Promise<AuthorizationServerMetadata> {
  const base = asIssuer.replace(/\/+$/, '');
  const url = `${base}/.well-known/oauth-authorization-server`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ASM fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint'] as const;
  for (const key of required) {
    if (typeof body[key] !== 'string') {
      throw new Error(`ASM missing required field ${key}`);
    }
  }
  return {
    issuer: String(body['issuer']),
    authorization_endpoint: String(body['authorization_endpoint']),
    token_endpoint: String(body['token_endpoint']),
    ...(typeof body['registration_endpoint'] === 'string'
      ? { registration_endpoint: String(body['registration_endpoint']) }
      : {}),
    code_challenge_methods_supported: Array.isArray(body['code_challenge_methods_supported'])
      ? (body['code_challenge_methods_supported'] as unknown[]).map(String)
      : ['S256'],
    grant_types_supported: Array.isArray(body['grant_types_supported'])
      ? (body['grant_types_supported'] as unknown[]).map(String)
      : ['authorization_code', 'refresh_token'],
    response_types_supported: Array.isArray(body['response_types_supported'])
      ? (body['response_types_supported'] as unknown[]).map(String)
      : ['code'],
    ...(Array.isArray(body['scopes_supported'])
      ? { scopes_supported: (body['scopes_supported'] as unknown[]).map(String) }
      : {}),
  };
}

/** End-to-end discovery: given just an MCP URL, return normalized metadata. */
export async function discoverMcpServer(mcpUrl: string): Promise<DiscoveryResult> {
  const canonicalResource = canonicalizeResource(mcpUrl);
  const prmUrl = await probeForResourceMetadata(mcpUrl);
  const prm = await fetchProtectedResourceMetadata(prmUrl);
  const asIssuer = prm.authorization_servers[0];
  if (!asIssuer) {
    throw new Error('PRM returned no authorization_servers');
  }
  const asm = await fetchAuthorizationServerMetadata(asIssuer);
  return { mcpUrl, canonicalResource, prm, asm };
}
