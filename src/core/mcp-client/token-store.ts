/**
 * Persistent token cache for the MCP OAuth 2.1 client, keyed by canonical MCP
 * server URL.
 *
 * Stored at `<vaultRoot>/.wikimem/mcp-client-tokens.json` with 0600 perms
 * (matches the convention in `src/mcp/oauth-store.ts`). Tokens are kept in
 * plaintext on disk for the v0.10.x phase — the v1.0 track (BUG-079-093) will
 * swap this helper for an encrypted-at-rest wrapper; all callers must route
 * through this module so that swap is a one-file change.
 *
 * NEVER log token values. `redactEntry()` exists for debug output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface McpClientTokenEntry {
  /** Canonical MCP server URL (output of canonicalizeResource). */
  mcp_url: string;
  /** OAuth client_id the tokens were issued to (DCR or static). */
  client_id: string;
  /** Optional client_secret for confidential clients. */
  client_secret?: string;
  access_token: string;
  refresh_token?: string;
  token_type: 'Bearer';
  /** Epoch ms when the access_token expires. */
  expires_at: number;
  /** Space-delimited scopes actually granted. */
  scope: string;
  /** AS metadata snapshot so refresh doesn't have to rediscover. */
  token_endpoint: string;
  issuer: string;
  /** Human-friendly label, e.g. "wikimem (localhost)", "Sentry MCP". */
  label?: string;
  created_at: number;
  updated_at: number;
}

interface TokenFileShape {
  version: 1;
  entries: Record<string, McpClientTokenEntry>;
}

function tokensFilePath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'mcp-client-tokens.json');
}

function readFile(vaultRoot: string): TokenFileShape {
  const path = tokensFilePath(vaultRoot);
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TokenFileShape;
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeFile(vaultRoot: string, data: TokenFileShape): void {
  const path = tokensFilePath(vaultRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-POSIX: ignore */
  }
}

export function getTokenEntry(
  vaultRoot: string,
  mcpUrl: string,
): McpClientTokenEntry | undefined {
  return readFile(vaultRoot).entries[mcpUrl];
}

export function saveTokenEntry(vaultRoot: string, entry: McpClientTokenEntry): void {
  const data = readFile(vaultRoot);
  data.entries[entry.mcp_url] = entry;
  writeFile(vaultRoot, data);
}

export function deleteTokenEntry(vaultRoot: string, mcpUrl: string): void {
  const data = readFile(vaultRoot);
  if (data.entries[mcpUrl]) {
    delete data.entries[mcpUrl];
    writeFile(vaultRoot, data);
  }
}

export function listTokenEntries(vaultRoot: string): McpClientTokenEntry[] {
  return Object.values(readFile(vaultRoot).entries);
}

/** Return the entry with secrets stripped, for safe logging or API responses. */
export function redactEntry(
  entry: McpClientTokenEntry,
): Omit<McpClientTokenEntry, 'access_token' | 'refresh_token' | 'client_secret'> {
  const { access_token: _a, refresh_token: _r, client_secret: _s, ...rest } = entry;
  return rest;
}

/** Quick staleness check with 30-second clock skew. */
export function isAccessTokenExpired(entry: McpClientTokenEntry): boolean {
  return entry.expires_at - 30_000 <= Date.now();
}
