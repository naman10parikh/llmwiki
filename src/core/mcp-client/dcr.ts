/**
 * Dynamic Client Registration (RFC 7591) for the MCP OAuth 2.1 client.
 *
 * Per the MCP 2025-06-18 spec, DCR is SHOULD-support. If the AS advertises a
 * `registration_endpoint`, we POST our client metadata there and receive a
 * fresh `client_id`. If DCR is unavailable, callers can pass a pre-registered
 * `client_id` through an alternate path (the Anthropic "Advanced settings"
 * pattern).
 */

import type { AuthorizationServerMetadata } from './metadata-discovery.js';

export interface RegisteredMcpClient {
  client_id: string;
  /** Set only when the AS chose to issue a secret (rare for OAuth 2.1 public). */
  client_secret?: string;
  token_endpoint_auth_method: string;
  /** Echoed back from AS — we default to PUBLIC (none) to match OAuth 2.1. */
  redirect_uris: string[];
  /** Opaque — emitted by some ASes; not used by client logic. */
  client_id_issued_at?: number;
}

export interface RegistrationInput {
  clientName: string;
  redirectUris: string[];
  scope: string;
}

/**
 * Register a public client via RFC 7591 Dynamic Client Registration.
 *
 * Throws if the AS did not advertise a `registration_endpoint` — callers
 * should fall back to `useStaticClientId()` with a user-pasted ID in that
 * case.
 */
export async function registerDynamicClient(
  asm: AuthorizationServerMetadata,
  input: RegistrationInput,
): Promise<RegisteredMcpClient> {
  if (!asm.registration_endpoint) {
    throw new Error(
      'AS does not advertise a registration_endpoint. Ask the user to paste a pre-registered client_id.',
    );
  }
  const res = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: input.scope,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DCR failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const clientId = body['client_id'];
  if (typeof clientId !== 'string') {
    throw new Error('DCR response missing client_id');
  }
  const redirectUris = Array.isArray(body['redirect_uris'])
    ? (body['redirect_uris'] as unknown[]).map(String)
    : input.redirectUris;
  const result: RegisteredMcpClient = {
    client_id: clientId,
    token_endpoint_auth_method:
      typeof body['token_endpoint_auth_method'] === 'string'
        ? (body['token_endpoint_auth_method'] as string)
        : 'none',
    redirect_uris: redirectUris,
  };
  if (typeof body['client_secret'] === 'string') {
    result.client_secret = body['client_secret'] as string;
  }
  if (typeof body['client_id_issued_at'] === 'number') {
    result.client_id_issued_at = body['client_id_issued_at'] as number;
  }
  return result;
}

/** Wrap a user-pasted pre-registered client ID in the same shape. */
export function useStaticClientId(
  clientId: string,
  redirectUris: string[],
  clientSecret?: string,
): RegisteredMcpClient {
  const result: RegisteredMcpClient = {
    client_id: clientId,
    token_endpoint_auth_method: clientSecret ? 'client_secret_basic' : 'none',
    redirect_uris: redirectUris,
  };
  if (clientSecret) result.client_secret = clientSecret;
  return result;
}
