/**
 * mcp-oauth.test.ts
 *
 * Proves wikimem's new MCP OAuth 2.1 surface is Claude-Connector compatible.
 *
 * Covers:
 *   - /.well-known/oauth-protected-resource metadata
 *   - /.well-known/oauth-authorization-server metadata
 *   - POST /oauth/register (DCR per RFC 7591)
 *   - POST /mcp without auth → 401 + WWW-Authenticate + resource_metadata
 *   - Full E2E: register → authorize (auto-approve) → token → /mcp tools/list
 *   - Scope enforcement: read:wiki ≠ write:wiki
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

import { createServer } from '../src/web/server.js';

const TEST_ROOT = join(process.cwd(), '.test-vault-mcp-oauth');
const PORT = 19878;

function cleanup(): void {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  text: string;
}

async function request(
  method: string,
  path: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    followRedirect?: boolean;
  } = {},
): Promise<HttpResult> {
  const { body, headers = {}, followRedirect = false } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          const location = res.headers['location'];
          if (followRedirect && res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && typeof location === 'string') {
            // For our authorize flow we want to inspect the Location header,
            // not follow it automatically.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request('GET', '/api/status');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Server at port ${PORT} did not become ready within ${timeoutMs}ms`);
}

function base64UrlEncode(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

beforeAll(async () => {
  cleanup();

  // Minimal vault shape expected by createServer()
  const wikiDir = join(TEST_ROOT, 'wiki');
  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(join(TEST_ROOT, 'raw'), { recursive: true });
  mkdirSync(join(TEST_ROOT, '.wikimem'), { recursive: true });
  writeFileSync(join(TEST_ROOT, 'AGENTS.md'), '# Wiki Schema\n', 'utf-8');
  writeFileSync(join(wikiDir, 'index.md'), '---\ntitle: Index\n---\n# Index\n\nWelcome.\n', 'utf-8');
  writeFileSync(join(TEST_ROOT, 'log.md'), '# Log\n', 'utf-8');

  // Force auto-approve so the authorize endpoint skips the HTML consent.
  process.env['WIKIMEM_OAUTH_AUTO_APPROVE'] = '1';
  // Deterministic signing secret for the test.
  process.env['WIKIMEM_OAUTH_SECRET'] = 'test-secret-' + 'x'.repeat(40);

  createServer(TEST_ROOT, PORT);
  await waitForServer();
});

afterAll(() => {
  delete process.env['WIKIMEM_OAUTH_AUTO_APPROVE'];
  delete process.env['WIKIMEM_OAUTH_SECRET'];
  cleanup();
});

describe('Well-known metadata endpoints', () => {
  it('GET /.well-known/oauth-protected-resource returns RFC 9728 shape', async () => {
    const res = await request('GET', '/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body['resource']).toBe('string');
    expect(Array.isArray(body['authorization_servers'])).toBe(true);
    expect(Array.isArray(body['scopes_supported'])).toBe(true);
    expect(Array.isArray(body['bearer_methods_supported'])).toBe(true);
    expect(body['bearer_methods_supported']).toContain('header');
    expect(body['scopes_supported']).toEqual(expect.arrayContaining(['read:wiki', 'write:wiki', 'admin']));
    expect(String(body['resource'])).toMatch(/\/mcp$/);
  });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 shape', async () => {
    const res = await request('GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body['issuer']).toBe('string');
    expect(typeof body['authorization_endpoint']).toBe('string');
    expect(typeof body['token_endpoint']).toBe('string');
    expect(typeof body['registration_endpoint']).toBe('string');
    expect(body['code_challenge_methods_supported']).toContain('S256');
    expect(body['grant_types_supported']).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
    expect(body['response_types_supported']).toContain('code');
    expect(body['token_endpoint_auth_methods_supported']).toContain('none');
  });
});

describe('Dynamic Client Registration (RFC 7591)', () => {
  it('POST /oauth/register issues a client_id for a public client', async () => {
    const res = await request(
      'POST',
      '/oauth/register',
      {
        body: JSON.stringify({
          redirect_uris: ['http://127.0.0.1:8000/callback'],
          client_name: 'Test DCR Client',
          token_endpoint_auth_method: 'none',
          scope: 'read:wiki write:wiki',
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body['client_id']).toBe('string');
    expect(String(body['client_id']).length).toBeGreaterThanOrEqual(16);
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body['grant_types']).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
    expect(body['response_types']).toEqual(['code']);
  });

  it('rejects redirect_uris that are not localhost/127.0.0.1 or HTTPS', async () => {
    const res = await request(
      'POST',
      '/oauth/register',
      {
        body: JSON.stringify({
          redirect_uris: ['http://evil.example.com/callback'],
          client_name: 'Bad',
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    expect(res.status).toBe(400);
  });
});

describe('MCP bearer auth gate', () => {
  it('POST /mcp without Authorization → 401 + WWW-Authenticate + resource_metadata', async () => {
    const res = await request(
      'POST',
      '/mcp',
      {
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    expect(res.status).toBe(401);
    const wwwAuth = res.headers['www-authenticate'];
    expect(typeof wwwAuth).toBe('string');
    expect(String(wwwAuth)).toContain('Bearer');
    expect(String(wwwAuth)).toContain('resource_metadata=');
    expect(String(wwwAuth)).toContain('/.well-known/oauth-protected-resource');
    const body = res.body as Record<string, unknown>;
    expect(body['error']).toBe('invalid_token');
  });

  it('GET /mcp without Authorization also returns 401 with WWW-Authenticate', async () => {
    const res = await request('GET', '/mcp');
    expect(res.status).toBe(401);
    expect(String(res.headers['www-authenticate'] ?? '')).toContain('resource_metadata');
  });
});

describe('End-to-end: DCR → authorize → token → /mcp', () => {
  it('completes the full OAuth 2.1 flow and returns wiki tools on /mcp', async () => {
    // Step 1: DCR
    const regRes = await request(
      'POST',
      '/oauth/register',
      {
        body: JSON.stringify({
          redirect_uris: ['http://127.0.0.1:65535/cb'],
          client_name: 'E2E Client',
          scope: 'read:wiki write:wiki admin',
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    expect(regRes.status).toBe(200);
    const client = regRes.body as { client_id: string };

    // Step 2: PKCE + authorize (auto-approve returns a redirect with code)
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(8).toString('hex');
    const authQs = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:65535/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'read:wiki write:wiki admin',
      resource: `http://127.0.0.1:${PORT}/mcp`,
    });
    const authRes = await request('GET', `/oauth/authorize?${authQs.toString()}`);
    expect(authRes.status).toBe(302);
    const location = authRes.headers['location'];
    expect(typeof location).toBe('string');
    const redirectUrl = new URL(String(location));
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe(state);

    // Step 3: token exchange
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:65535/cb',
      code_verifier: verifier,
      resource: `http://127.0.0.1:${PORT}/mcp`,
    }).toString();
    const tokenRes = await request(
      'POST',
      '/oauth/token',
      {
        body: tokenBody,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    expect(tokenRes.status).toBe(200);
    const token = tokenRes.body as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(token.token_type).toBe('Bearer');
    expect(typeof token.access_token).toBe('string');
    expect(token.access_token.split('.').length).toBe(3); // JWT
    expect(typeof token.refresh_token).toBe('string');
    expect(token.expires_in).toBeGreaterThan(0);

    // Step 4: /mcp tools/list
    const mcpRes = await request(
      'POST',
      '/mcp',
      {
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.access_token}`,
        },
      },
    );
    expect(mcpRes.status).toBe(200);
    const rpcBody = mcpRes.body as { jsonrpc: string; id: number; result: { tools: Array<{ name: string }> } };
    expect(rpcBody.jsonrpc).toBe('2.0');
    expect(rpcBody.id).toBe(42);
    expect(Array.isArray(rpcBody.result.tools)).toBe(true);
    const toolNames = rpcBody.result.tools.map((t) => t.name);
    expect(toolNames).toContain('wikimem_search');
    expect(toolNames).toContain('wikimem_list');
    expect(toolNames.length).toBeGreaterThanOrEqual(19);

    // Step 5: refresh token rotation
    const refreshRes = await request(
      'POST',
      '/oauth/token',
      {
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: client.client_id,
        }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    expect(refreshRes.status).toBe(200);
    const rotated = refreshRes.body as { access_token: string; refresh_token: string };
    expect(rotated.access_token).not.toBe(token.access_token);
    expect(rotated.refresh_token).not.toBe(token.refresh_token);

    // Old refresh token should now be invalid.
    const reuseRes = await request(
      'POST',
      '/oauth/token',
      {
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: client.client_id,
        }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    expect(reuseRes.status).toBe(400);
  });
});

describe('Scope enforcement', () => {
  async function mintTokenWithScope(scope: string): Promise<string> {
    // Register a client
    const regRes = await request(
      'POST',
      '/oauth/register',
      {
        body: JSON.stringify({
          redirect_uris: ['http://127.0.0.1:65535/cb'],
          client_name: `Scope Client ${scope}`,
          scope,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const client = regRes.body as { client_id: string };
    const { verifier, challenge } = generatePkce();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:65535/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      scope,
      resource: `http://127.0.0.1:${PORT}/mcp`,
    });
    const authRes = await request('GET', `/oauth/authorize?${qs.toString()}`);
    const location = authRes.headers['location'];
    const redirectUrl = new URL(String(location));
    const code = redirectUrl.searchParams.get('code');
    const tokenRes = await request(
      'POST',
      '/oauth/token',
      {
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: client.client_id,
          redirect_uri: 'http://127.0.0.1:65535/cb',
          code_verifier: verifier,
          resource: `http://127.0.0.1:${PORT}/mcp`,
        }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    const token = tokenRes.body as { access_token: string };
    return token.access_token;
  }

  it('read:wiki token can call wikimem_search but NOT wikimem_ingest', async () => {
    const readToken = await mintTokenWithScope('read:wiki');

    // read allowed
    const searchRes = await request(
      'POST',
      '/mcp',
      {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'wikimem_search', arguments: { query: 'index', limit: 1 } },
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${readToken}`,
        },
      },
    );
    expect(searchRes.status).toBe(200);
    const searchBody = searchRes.body as { result?: unknown; error?: { code: number } };
    expect(searchBody.result).toBeDefined();
    expect(searchBody.error).toBeUndefined();

    // write denied
    const writeRes = await request(
      'POST',
      '/mcp',
      {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'wikimem_ingest', arguments: { source: '/tmp/nope.md' } },
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${readToken}`,
        },
      },
    );
    expect(writeRes.status).toBe(403);
    const writeBody = writeRes.body as { error?: { code: number; message: string } };
    expect(writeBody.error?.code).toBe(-32001);
    expect(writeBody.error?.message ?? '').toContain('write:wiki');
  });
});
