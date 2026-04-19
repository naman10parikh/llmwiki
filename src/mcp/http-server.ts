/**
 * HTTP transport for wikimem's MCP server.
 *
 * - Enforces Bearer auth against the local AS (see oauth-server.ts).
 * - Dispatches JSON-RPC 2.0 to the same toolset as `wikimem mcp` stdio.
 * - Supports optional SSE streaming for long tool calls: if the client
 *   accepts `text/event-stream`, we flush an initial `progress` event and
 *   send the final `result` event with the JSON-RPC response payload.
 *
 * Register via `registerMcpHttpRoutes(app, { vaultRoot, port })`.
 */

import type { Express, Request, Response } from 'express';

import {
  MCP_PATH,
  WELL_KNOWN_PROTECTED_RESOURCE,
  resolveCanonicalResource,
  WIKIMEM_SCOPES,
} from './oauth-endpoints.js';
import { applyCorsHeaders, computeIssuer, extractBearerToken } from './oauth-helpers.js';
import { getOrCreateOAuthSecret } from './oauth-store.js';
import { verifyJwt } from './jwt.js';
import { dispatchJsonRpc } from '../mcp-server.js';

interface McpHttpOptions {
  vaultRoot: string;
  port: number;
}

interface AuthContext {
  userId: string;
  scope: string;
  clientId: string;
}

/** Tools whose names imply mutation; read:wiki is not enough to call these. */
const WRITE_TOOLS = new Set<string>([
  'wikimem_ingest',
  'wikimem_ingest_url',
  'wikimem_scrape',
  'wikimem_connectors',
  'wikimem_connect',
  'wikimem_sync',
  'wikimem_improve',
]);

const ADMIN_TOOLS = new Set<string>([
  'wikimem_run_observer',
  'wikimem_lint',
]);

function sendUnauthorized(
  res: Response,
  issuer: string,
  errorDescription: string,
): void {
  const resourceMetadataUrl = `${issuer}${WELL_KNOWN_PROTECTED_RESOURCE}`;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="wikimem", resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="${errorDescription}"`,
  );
  res.status(401).json({
    error: 'invalid_token',
    error_description: errorDescription,
    resource_metadata: resourceMetadataUrl,
  });
}

function authorize(req: Request, vaultRoot: string, canonicalResource: string): {
  ok: true;
  ctx: AuthContext;
} | { ok: false; reason: string } {
  const token = extractBearerToken(req);
  if (!token) return { ok: false, reason: 'missing bearer token' };
  const secret = getOrCreateOAuthSecret(vaultRoot);
  const verification = verifyJwt(token, secret, canonicalResource);
  if (!verification.valid || !verification.claims) {
    return { ok: false, reason: verification.reason ?? 'invalid token' };
  }
  if (verification.claims.typ !== 'access') {
    return { ok: false, reason: 'wrong token type' };
  }
  return {
    ok: true,
    ctx: {
      userId: verification.claims.sub,
      scope: verification.claims.scope,
      clientId: verification.claims.client_id,
    },
  };
}

function scopeIncludes(scope: string, needle: string): boolean {
  return scope.split(/\s+/).includes(needle);
}

function requiredScopeFor(toolName: string): string {
  if (ADMIN_TOOLS.has(toolName)) return 'admin';
  if (WRITE_TOOLS.has(toolName)) return 'write:wiki';
  return 'read:wiki';
}

function isScopeAuthorized(scope: string, needed: string): boolean {
  // `admin` supersedes write, which supersedes read.
  if (scope.includes('admin')) return true;
  if (needed === 'read:wiki') {
    return scopeIncludes(scope, 'read:wiki') || scopeIncludes(scope, 'write:wiki');
  }
  if (needed === 'write:wiki') {
    return scopeIncludes(scope, 'write:wiki');
  }
  if (needed === 'admin') return scopeIncludes(scope, 'admin');
  return false;
}

interface JsonRpcShape {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function asJsonRpcRequest(payload: unknown): {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as JsonRpcShape;
  if (p.jsonrpc !== '2.0') return null;
  if (typeof p.method !== 'string') return null;
  const id = (typeof p.id === 'string' || typeof p.id === 'number' || p.id === null || p.id === undefined)
    ? ((p.id ?? null) as string | number | null)
    : null;
  return {
    jsonrpc: '2.0',
    id,
    method: p.method,
    ...(p.params !== undefined ? { params: p.params } : {}),
  };
}

export function registerMcpHttpRoutes(app: Express, opts: McpHttpOptions): void {
  const { vaultRoot, port } = opts;

  // GET /mcp: browsers visiting it directly get a friendly 401 so discovery
  // still works without surprising them.
  app.get(MCP_PATH, (req, res) => {
    applyCorsHeaders(res);
    const issuer = computeIssuer(req, port);
    sendUnauthorized(res, issuer, 'Authorization required to access MCP endpoint.');
  });

  app.post(MCP_PATH, async (req, res) => {
    applyCorsHeaders(res);
    const issuer = computeIssuer(req, port);
    const canonicalResource = resolveCanonicalResource(issuer);

    const auth = authorize(req, vaultRoot, canonicalResource);
    if (!auth.ok) {
      sendUnauthorized(res, issuer, auth.reason);
      return;
    }

    const rpc = asJsonRpcRequest(req.body);
    if (!rpc) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
      });
      return;
    }

    // Enforce scope for tools/call.
    if (rpc.method === 'tools/call') {
      const params = rpc.params as { name?: string } | undefined;
      const toolName = typeof params?.name === 'string' ? params.name : '';
      const needed = requiredScopeFor(toolName);
      if (!isScopeAuthorized(auth.ctx.scope, needed)) {
        res.status(403).json({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32001, message: `Insufficient scope — ${needed} required` },
        });
        return;
      }
    }

    const acceptHeader = (req.get('accept') ?? '').toLowerCase();
    const wantsSse = acceptHeader.includes('text/event-stream');

    try {
      const response = await dispatchJsonRpc(rpc, vaultRoot);

      if (wantsSse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        // Send a progress frame up front so the client's SSE parser wakes up.
        res.write(`event: progress\ndata: ${JSON.stringify({ status: 'starting', method: rpc.method })}\n\n`);
        const payload = response ?? { jsonrpc: '2.0', id: rpc.id, result: {} };
        res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
        return;
      }

      if (!response) {
        // Notifications have no response — mirror that with 204 so clients
        // know we accepted the message.
        res.status(204).end();
        return;
      }
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32603, message: `Internal error: ${message}` },
      });
    }
  });
}

/** Export scope helpers for tests. */
export const __internals = {
  scopeIncludes,
  isScopeAuthorized,
  requiredScopeFor,
  WRITE_TOOLS,
  ADMIN_TOOLS,
  allScopes: WIKIMEM_SCOPES,
};
