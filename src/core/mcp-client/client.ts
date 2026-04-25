/**
 * McpClient — the public entry point wikimem uses to talk to REMOTE MCP
 * servers that implement the OAuth 2.1 "2025-06-18" authorization spec.
 *
 * Lifecycle:
 *   1. `connect(mcpUrl)` — runs the full discovery + DCR + builds the browser
 *      URL the user opens. Does NOT wait for the user — that's the caller's
 *      responsibility (see src/web/server.ts mcp-client routes).
 *   2. `finalize(mcpUrl, code, verifier)` — called from the callback route
 *      after the AS 302s back with `?code=`. Exchanges the code for tokens,
 *      persists them, and unlocks `listTools()` / `callTool()`.
 *   3. `listTools(mcpUrl)` / `callTool(mcpUrl, name, args)` — standard MCP
 *      JSON-RPC over HTTP, always carrying `Authorization: Bearer <access>`.
 *      On 401 with a valid `WWW-Authenticate`, the client refreshes the token
 *      and retries once.
 *   4. `refresh(mcpUrl)` — manual token rotation.
 *   5. `disconnect(mcpUrl)` — wipes the stored tokens.
 *
 * This mirrors the primitives in `src/mcp/oauth-server.ts` but from the CLIENT
 * side. Anything that changes the wire format MUST stay symmetric with that
 * module so wikimem can always OAuth against itself (the self-test flow).
 */

import {
  discoverMcpServer,
  type DiscoveryResult,
} from './metadata-discovery.js';
import {
  registerDynamicClient,
  useStaticClientId,
  type RegisteredMcpClient,
} from './dcr.js';
import { canonicalizeResource, generatePkce, generateState } from './oauth-pkce.js';
import {
  getTokenEntry,
  saveTokenEntry,
  deleteTokenEntry,
  listTokenEntries,
  isAccessTokenExpired,
  redactEntry,
  type McpClientTokenEntry,
} from './token-store.js';

export interface ConnectInput {
  /** Raw MCP server URL — will be canonicalized. */
  mcpUrl: string;
  /** Where the AS should redirect after consent (wikimem's callback route). */
  redirectUri: string;
  /** Human label shown in the UI. Defaults to the hostname. */
  label?: string;
  /** Space-separated scopes to request. Defaults to discovered scopes. */
  scope?: string;
  /** Pre-registered client_id for AS that don't support DCR. */
  staticClientId?: string;
  /** Matching client_secret (only when the AS issued one). */
  staticClientSecret?: string;
}

export interface ConnectPrepared {
  /** URL to open in the user's browser. */
  authorizeUrl: string;
  /** PKCE verifier — MUST be held in server memory until the callback fires. */
  codeVerifier: string;
  /** CSRF token — MUST match on callback. */
  state: string;
  /** Canonical resource identifier — audience in the token's `aud` claim. */
  canonicalResource: string;
  /** Snapshot of the discovery result so the callback can do the token swap. */
  discovery: DiscoveryResult;
  /** Registered client metadata (DCR output or static wrapper). */
  client: RegisteredMcpClient;
  /** Scopes actually being requested. */
  scope: string;
  /** Redirect URI — echo it so the callback can verify an exact match. */
  redirectUri: string;
  /** Friendly label captured at connect time. */
  label: string;
}

export interface TokenBundle {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

/** Thrown when a connection has never been authorized. */
export class NotConnectedError extends Error {
  constructor(mcpUrl: string) {
    super(`No OAuth tokens stored for MCP server ${mcpUrl}. Run connect() first.`);
    this.name = 'NotConnectedError';
  }
}

/** Thrown when refresh rotation fails and we can't recover. */
export class RefreshFailedError extends Error {
  constructor(mcpUrl: string, reason: string) {
    super(`Token refresh failed for ${mcpUrl}: ${reason}`);
    this.name = 'RefreshFailedError';
  }
}

export interface McpClientOptions {
  vaultRoot: string;
  /** Override the client name sent in DCR (default: "wikimem-mcp-client"). */
  clientName?: string;
  /** Default scope if the AS doesn't advertise one. */
  defaultScope?: string;
}

/**
 * Shape a scope string for a server. Prefers caller-supplied scope, falls
 * back to the scopes advertised in PRM/ASM, falls back to "read:wiki".
 */
function resolveScope(
  input: { scope?: string; defaultScope?: string },
  discovery: DiscoveryResult,
): string {
  if (input.scope && input.scope.trim()) return input.scope.trim();
  const prmScopes = discovery.prm.scopes_supported.filter(Boolean);
  if (prmScopes.length > 0) return prmScopes.join(' ');
  const asmScopes = discovery.asm.scopes_supported?.filter(Boolean) ?? [];
  if (asmScopes.length > 0) return asmScopes.join(' ');
  return input.defaultScope ?? 'read:wiki';
}

function deriveLabel(mcpUrl: string, override?: string): string {
  if (override && override.trim()) return override.trim();
  try {
    const u = new URL(mcpUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost'
      ? `wikimem (self-test — ${u.port || '80'})`
      : u.hostname;
  } catch {
    return mcpUrl;
  }
}

export class McpClient {
  private readonly vaultRoot: string;
  private readonly clientName: string;
  private readonly defaultScope?: string;

  constructor(opts: McpClientOptions) {
    this.vaultRoot = opts.vaultRoot;
    this.clientName = opts.clientName ?? 'wikimem-mcp-client';
    if (opts.defaultScope !== undefined) {
      this.defaultScope = opts.defaultScope;
    }
  }

  /**
   * Phase 1 of the connect flow. Returns a `ConnectPrepared` containing the
   * URL the user must open in their browser. The caller is responsible for
   * holding `codeVerifier` + `state` in memory keyed by `state`, then
   * completing via `finalize()` on the callback.
   */
  async connect(input: ConnectInput): Promise<ConnectPrepared> {
    const mcpUrl = canonicalizeResource(input.mcpUrl);
    const discovery = await discoverMcpServer(mcpUrl);

    let client: RegisteredMcpClient;
    if (input.staticClientId) {
      client = useStaticClientId(
        input.staticClientId,
        [input.redirectUri],
        input.staticClientSecret,
      );
    } else if (discovery.asm.registration_endpoint) {
      client = await registerDynamicClient(discovery.asm, {
        clientName: this.clientName,
        redirectUris: [input.redirectUri],
        scope: resolveScope({ ...input, ...(this.defaultScope !== undefined ? { defaultScope: this.defaultScope } : {}) }, discovery),
      });
    } else {
      throw new Error(
        'MCP server advertises no registration_endpoint and no static client_id was supplied. Pass staticClientId to connect().',
      );
    }

    const scope = resolveScope({ ...input, ...(this.defaultScope !== undefined ? { defaultScope: this.defaultScope } : {}) }, discovery);
    const pkce = generatePkce();
    const state = generateState();

    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: input.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      scope,
      resource: discovery.canonicalResource,
    });
    const authorizeUrl = `${discovery.asm.authorization_endpoint}?${qs.toString()}`;

    return {
      authorizeUrl,
      codeVerifier: pkce.verifier,
      state,
      canonicalResource: discovery.canonicalResource,
      discovery,
      client,
      scope,
      redirectUri: input.redirectUri,
      label: deriveLabel(mcpUrl, input.label),
    };
  }

  /**
   * Phase 2 of connect. Called from the OAuth redirect handler. Exchanges the
   * one-time code for `{access, refresh}` tokens and persists them.
   */
  async finalize(
    prepared: ConnectPrepared,
    authorizationCode: string,
  ): Promise<McpClientTokenEntry> {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: prepared.redirectUri,
      code_verifier: prepared.codeVerifier,
      client_id: prepared.client.client_id,
      resource: prepared.canonicalResource,
    });
    if (prepared.client.client_secret) {
      tokenBody.set('client_secret', prepared.client.client_secret);
    }

    const tokens = await this.tokenRequest(
      prepared.discovery.asm.token_endpoint,
      tokenBody,
      prepared.client,
    );

    const now = Date.now();
    const entry: McpClientTokenEntry = {
      mcp_url: prepared.canonicalResource,
      client_id: prepared.client.client_id,
      ...(prepared.client.client_secret ? { client_secret: prepared.client.client_secret } : {}),
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      token_type: 'Bearer',
      expires_at: now + tokens.expires_in * 1000,
      scope: tokens.scope ?? prepared.scope,
      token_endpoint: prepared.discovery.asm.token_endpoint,
      issuer: prepared.discovery.asm.issuer,
      label: prepared.label,
      created_at: now,
      updated_at: now,
    };
    saveTokenEntry(this.vaultRoot, entry);
    return entry;
  }

  /** Force a refresh using the stored refresh_token. Rotates the pair. */
  async refresh(mcpUrl: string): Promise<McpClientTokenEntry> {
    const canonical = canonicalizeResource(mcpUrl);
    const existing = getTokenEntry(this.vaultRoot, canonical);
    if (!existing) throw new NotConnectedError(canonical);
    if (!existing.refresh_token) {
      throw new RefreshFailedError(canonical, 'no refresh_token on file — reconnect');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refresh_token,
      client_id: existing.client_id,
      resource: canonical,
    });
    if (existing.client_secret) body.set('client_secret', existing.client_secret);

    const tokens = await this.tokenRequest(
      existing.token_endpoint,
      body,
      { client_id: existing.client_id, ...(existing.client_secret ? { client_secret: existing.client_secret } : {}) },
    );
    const now = Date.now();
    const updated: McpClientTokenEntry = {
      ...existing,
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : { refresh_token: existing.refresh_token }),
      expires_at: now + tokens.expires_in * 1000,
      scope: tokens.scope ?? existing.scope,
      updated_at: now,
    };
    saveTokenEntry(this.vaultRoot, updated);
    return updated;
  }

  /** JSON-RPC `tools/list`. Returns normalized tool metadata. */
  async listTools(mcpUrl: string): Promise<ListedTool[]> {
    const result = await this.jsonRpc<{ tools?: ListedTool[] }>(
      canonicalizeResource(mcpUrl),
      'tools/list',
    );
    return Array.isArray(result.tools) ? result.tools : [];
  }

  /** JSON-RPC `tools/call`. Passes through MCP result shape. */
  async callTool(
    mcpUrl: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult> {
    return this.jsonRpc<ToolCallResult>(
      canonicalizeResource(mcpUrl),
      'tools/call',
      { name, arguments: args },
    );
  }

  /** Enumerate every currently-connected MCP server (redacted). */
  listConnections(): Array<ReturnType<typeof redactEntry>> {
    return listTokenEntries(this.vaultRoot).map(redactEntry);
  }

  /** Delete the tokens for a server. Caller may re-connect after. */
  disconnect(mcpUrl: string): void {
    deleteTokenEntry(this.vaultRoot, canonicalizeResource(mcpUrl));
  }

  /** For tests: expose the raw entry (INCLUDES SECRETS). */
  _getEntry(mcpUrl: string): McpClientTokenEntry | undefined {
    return getTokenEntry(this.vaultRoot, canonicalizeResource(mcpUrl));
  }

  /** Shared helper: call the token endpoint and return a normalized bundle. */
  private async tokenRequest(
    tokenEndpoint: string,
    body: URLSearchParams,
    client: { client_id: string; client_secret?: string },
  ): Promise<TokenBundle> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (client.client_secret) {
      const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
    const res = await fetch(tokenEndpoint, { method: 'POST', headers, body: body.toString() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Token endpoint ${tokenEndpoint} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const access = json['access_token'];
    const tokenType = json['token_type'];
    const expiresIn = json['expires_in'];
    if (typeof access !== 'string' || typeof tokenType !== 'string' || typeof expiresIn !== 'number') {
      throw new Error(`Malformed token response from ${tokenEndpoint}`);
    }
    const result: TokenBundle = {
      access_token: access,
      token_type: tokenType,
      expires_in: expiresIn,
      scope: typeof json['scope'] === 'string' ? (json['scope'] as string) : '',
    };
    if (typeof json['refresh_token'] === 'string') {
      result.refresh_token = json['refresh_token'] as string;
    }
    return result;
  }

  /**
   * JSON-RPC-over-HTTP with automatic token refresh.
   *
   * Flow:
   *   1. Load entry from token store; refresh if expired.
   *   2. POST to the canonical MCP URL with `Authorization: Bearer`.
   *   3. On 401, attempt one refresh + retry.
   *   4. Parse JSON-RPC response; throw on `error` field.
   */
  private async jsonRpc<T>(
    canonical: string,
    method: string,
    params: unknown = undefined,
  ): Promise<T> {
    let entry = getTokenEntry(this.vaultRoot, canonical);
    if (!entry) throw new NotConnectedError(canonical);
    if (isAccessTokenExpired(entry)) {
      entry = await this.refresh(canonical);
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method,
      ...(params !== undefined ? { params } : {}),
    });

    const doFetch = async (accessToken: string): Promise<Response> =>
      fetch(canonical, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body,
      });

    let res = await doFetch(entry.access_token);
    if (res.status === 401) {
      // One retry after refresh. If there's no refresh_token we surface the
      // error so the UI can prompt for reconnect.
      if (!entry.refresh_token) {
        throw new RefreshFailedError(canonical, '401 with no refresh_token');
      }
      entry = await this.refresh(canonical);
      res = await doFetch(entry.access_token);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${method} → ${res.status}: ${text.slice(0, 300)}`);
    }

    // Some servers answer notifications with 204 — treat as empty result.
    if (res.status === 204) return {} as T;

    const json = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (json.error) {
      throw new Error(`MCP ${method} JSON-RPC error ${json.error.code}: ${json.error.message}`);
    }
    return (json.result ?? ({} as T));
  }
}
