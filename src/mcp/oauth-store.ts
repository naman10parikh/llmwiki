/**
 * Persistent storage for OAuth artifacts used by the wikimem MCP AS.
 *
 * Single-user local deployment — we do not need Postgres. One JSON file under
 * `<vaultRoot>/.wikimem/oauth-clients.json` holds registered clients. The
 * signing secret lives at `<vaultRoot>/.wikimem/oauth-secret`.
 *
 * Refresh tokens and authorization codes are held in memory because they are
 * short-lived and binding them to disk would create a replay/rotation headache
 * on process restart. Clients simply re-authenticate if the server restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope: string;
}

interface ClientsFileShape {
  clients: RegisteredClient[];
}

function clientsFilePath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'oauth-clients.json');
}

function secretFilePath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'oauth-secret');
}

/**
 * Load the OAuth signing secret for this vault. Auto-generates and persists a
 * fresh 32-byte secret on first call (similar to `.env.local` bootstrap).
 *
 * Precedence: `WIKIMEM_OAUTH_SECRET` env var > persisted file > freshly
 * generated + persisted file.
 */
export function getOrCreateOAuthSecret(vaultRoot: string): string {
  const envSecret = process.env['WIKIMEM_OAUTH_SECRET'];
  if (envSecret && envSecret.length >= 32) return envSecret;

  const path = secretFilePath(vaultRoot);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8').trim();
    if (existing.length >= 32) return existing;
  }

  mkdirSync(dirname(path), { recursive: true });
  const fresh = randomBytes(48).toString('hex');
  writeFileSync(path, fresh, 'utf-8');
  try { chmodSync(path, 0o600); } catch { /* non-fatal on non-POSIX */ }
  return fresh;
}

function readClientsFile(vaultRoot: string): ClientsFileShape {
  const path = clientsFilePath(vaultRoot);
  if (!existsSync(path)) return { clients: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ClientsFileShape;
    if (!Array.isArray(parsed.clients)) return { clients: [] };
    return parsed;
  } catch {
    return { clients: [] };
  }
}

function writeClientsFile(vaultRoot: string, data: ClientsFileShape): void {
  const path = clientsFilePath(vaultRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  try { chmodSync(path, 0o600); } catch { /* non-fatal */ }
}

export function listClients(vaultRoot: string): RegisteredClient[] {
  return readClientsFile(vaultRoot).clients;
}

export function getClient(vaultRoot: string, clientId: string): RegisteredClient | undefined {
  return readClientsFile(vaultRoot).clients.find((c) => c.client_id === clientId);
}

export function saveClient(vaultRoot: string, client: RegisteredClient): void {
  const data = readClientsFile(vaultRoot);
  // Replace if an entry with the same client_id already exists
  const existing = data.clients.findIndex((c) => c.client_id === client.client_id);
  if (existing >= 0) {
    data.clients[existing] = client;
  } else {
    data.clients.push(client);
  }
  writeClientsFile(vaultRoot, data);
}

// ─── In-memory authorization code store ────────────────────────────────────

export interface AuthorizationCodeEntry {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  resource: string;
  user_id: string;
  expires_at: number;
}

const authorizationCodes = new Map<string, AuthorizationCodeEntry>();

export function saveAuthorizationCode(entry: AuthorizationCodeEntry): void {
  authorizationCodes.set(entry.code, entry);
}

export function consumeAuthorizationCode(code: string): AuthorizationCodeEntry | undefined {
  const entry = authorizationCodes.get(code);
  if (!entry) return undefined;
  authorizationCodes.delete(code);
  if (entry.expires_at < Date.now()) return undefined;
  return entry;
}

/** Housekeeping: drop any codes that have aged out. */
export function pruneExpiredAuthorizationCodes(): void {
  const now = Date.now();
  for (const [code, entry] of authorizationCodes) {
    if (entry.expires_at < now) authorizationCodes.delete(code);
  }
}

// ─── In-memory refresh token store ─────────────────────────────────────────

export interface RefreshTokenEntry {
  token: string;
  client_id: string;
  scope: string;
  resource: string;
  user_id: string;
  expires_at: number;
}

const refreshTokens = new Map<string, RefreshTokenEntry>();

export function saveRefreshToken(entry: RefreshTokenEntry): void {
  refreshTokens.set(entry.token, entry);
}

export function consumeRefreshToken(token: string): RefreshTokenEntry | undefined {
  const entry = refreshTokens.get(token);
  if (!entry) return undefined;
  // Rotate — invalidate immediately on use.
  refreshTokens.delete(token);
  if (entry.expires_at < Date.now()) return undefined;
  return entry;
}

export function pruneExpiredRefreshTokens(): void {
  const now = Date.now();
  for (const [token, entry] of refreshTokens) {
    if (entry.expires_at < now) refreshTokens.delete(token);
  }
}

// ─── Session state for consent dedup ───────────────────────────────────────

/**
 * Remember which clients have already been allowed in the current server
 * process so a second authorize request for the same client bypasses the
 * consent screen. Local-single-user only — this is not a long-lived grant.
 */
const sessionApprovedClients = new Set<string>();

export function hasSessionApproval(clientId: string): boolean {
  return sessionApprovedClients.has(clientId);
}

export function recordSessionApproval(clientId: string): void {
  sessionApprovedClients.add(clientId);
}
