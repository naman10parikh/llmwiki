/**
 * Small helpers shared by the OAuth AS and the MCP HTTP transport.
 *
 * Kept separate so oauth-server.ts stays below the ~400-line guideline
 * and the consent page HTML is easy to iterate on without touching
 * route handler logic.
 */

import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

import { resolveCanonicalIssuer } from './oauth-endpoints.js';

/** Cheap HTML escape used only in the consent template. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** PKCE verifier: SHA256(verifier) base64-url-encoded must match challenge. */
export function pkceVerifies(verifier: string, challenge: string): boolean {
  const hash = createHash('sha256').update(verifier).digest();
  const expected = hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Derive the canonical issuer from the incoming request + env fallback. */
export function computeIssuer(req: Request, defaultPort: number): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = (forwardedProto?.split(',')[0]?.trim()) ?? req.protocol ?? 'http';
  const host = req.get('host') ?? `127.0.0.1:${defaultPort}`;
  const fallback = `http://127.0.0.1:${defaultPort}`;
  return resolveCanonicalIssuer(host, proto, fallback);
}

/** Apply CORS headers for the OAuth + MCP surface. */
export function applyCorsHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, MCP-Protocol-Version',
  );
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
}

interface ConsentPageParams {
  clientName: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  resource: string;
  formAction: string;
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'read:wiki': 'Read pages, search, list sources',
  'write:wiki': 'Create and edit pages',
  admin: 'Manage connectors, run the observer',
};

export function renderConsentPage(params: ConsentPageParams): string {
  const scopes = params.scope.split(' ').filter(Boolean);
  const scopeRows = scopes
    .map((s) => {
      const description = SCOPE_DESCRIPTIONS[s] ?? '';
      return `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(description)}</li>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Connect to WikiMem</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #141312; color: #eaeaea; margin: 0; display: grid; place-items: center; min-height: 100vh; }
    .card { background: #1d1c1a; border: 1px solid #2a2a28; border-radius: 14px; padding: 32px 40px; max-width: 480px; width: 90%; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { color: #b3b3b3; line-height: 1.5; }
    ul { padding-left: 18px; color: #cfcfcf; }
    code { background: #2a2a28; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .actions { margin-top: 24px; display: flex; gap: 12px; }
    button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 0; cursor: pointer; font-weight: 500; }
    .allow { background: #6b21a8; color: #fff; }
    .allow:hover { background: #581c87; }
    .deny { background: #2a2a28; color: #eaeaea; }
    .deny:hover { background: #333; }
    .meta { margin-top: 20px; font-size: 12px; color: #7a7a7a; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="${escapeHtml(params.formAction)}">
    <h1>Connect to WikiMem</h1>
    <p>Client <strong>${escapeHtml(params.clientName)}</strong> is requesting access to your wiki.</p>
    <ul>${scopeRows}</ul>
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
    <input type="hidden" name="scope" value="${escapeHtml(params.scope)}" />
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}" />
    <input type="hidden" name="state" value="${escapeHtml(params.state)}" />
    <input type="hidden" name="resource" value="${escapeHtml(params.resource)}" />
    <div class="actions">
      <button class="allow" name="action" value="allow" type="submit">Allow</button>
      <button class="deny" name="action" value="deny" type="submit">Deny</button>
    </div>
    <div class="meta">Resource: <code>${escapeHtml(params.resource)}</code></div>
  </form>
</body>
</html>`;
}

/** Validate a redirect URI per the DCR profile we accept. */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

/** Look for Bearer token in the Authorization header. */
export function extractBearerToken(req: Request): string | null {
  const header = req.get('authorization') ?? req.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  return match[1];
}
