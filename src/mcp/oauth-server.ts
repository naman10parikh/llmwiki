/**
 * OAuth 2.1 Authorization Server for wikimem's MCP transport.
 *
 * Implements the minimum surface needed to make wikimem act as a
 * Claude-Connector-compatible AS:
 *   - GET  /.well-known/oauth-protected-resource  (RFC 9728)
 *   - GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   - POST /oauth/register                         (RFC 7591 — DCR)
 *   - GET  /oauth/authorize                        (RFC 6749 + OAuth 2.1 PKCE)
 *   - POST /oauth/token                            (RFC 6749 + PKCE)
 *
 * Wire these into an Express app via `registerOAuthRoutes(app, vaultRoot)`.
 */

import type { Express } from 'express';
import { randomBytes } from 'node:crypto';

import {
  WELL_KNOWN_AUTHORIZATION_SERVER,
  WELL_KNOWN_PROTECTED_RESOURCE,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_REGISTER_PATH,
  MCP_PATH,
  WIKIMEM_SCOPES,
  RESPONSE_TYPES_SUPPORTED,
  GRANT_TYPES_SUPPORTED,
  CODE_CHALLENGE_METHODS_SUPPORTED,
  TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
  BEARER_METHODS_SUPPORTED,
  AUTHORIZATION_CODE_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  RESOURCE_DOCUMENTATION_URL,
  resolveCanonicalResource,
} from './oauth-endpoints.js';
import {
  applyCorsHeaders,
  computeIssuer,
  isValidRedirectUri,
  pkceVerifies,
  renderConsentPage,
} from './oauth-helpers.js';
import {
  getOrCreateOAuthSecret,
  getClient,
  saveClient,
  saveAuthorizationCode,
  consumeAuthorizationCode,
  saveRefreshToken,
  consumeRefreshToken,
  hasSessionApproval,
  recordSessionApproval,
  pruneExpiredAuthorizationCodes,
  pruneExpiredRefreshTokens,
  type RegisteredClient,
} from './oauth-store.js';
import { signJwt, newJti, type JwtClaims } from './jwt.js';

interface OAuthRouteOptions {
  vaultRoot: string;
  /** Port the web server is bound to — used for local URL fallbacks. */
  port: number;
}

export function registerOAuthRoutes(app: Express, opts: OAuthRouteOptions): void {
  const { vaultRoot, port } = opts;

  // Make sure the signing secret exists up front so we never surprise clients
  // mid-flow with a freshly-minted secret for a token that was issued before.
  getOrCreateOAuthSecret(vaultRoot);

  // OPTIONS preflight for the well-known + oauth paths
  app.options(
    [
      WELL_KNOWN_PROTECTED_RESOURCE,
      WELL_KNOWN_AUTHORIZATION_SERVER,
      OAUTH_REGISTER_PATH,
      OAUTH_AUTHORIZE_PATH,
      OAUTH_TOKEN_PATH,
      MCP_PATH,
    ],
    (_req, res) => {
      applyCorsHeaders(res);
      res.status(204).end();
    },
  );

  // ─── RFC 9728: Protected Resource Metadata ─────────────────────────────
  app.get(WELL_KNOWN_PROTECTED_RESOURCE, (req, res) => {
    applyCorsHeaders(res);
    const issuer = computeIssuer(req, port);
    const resource = resolveCanonicalResource(issuer);
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [...WIKIMEM_SCOPES],
      bearer_methods_supported: [...BEARER_METHODS_SUPPORTED],
      resource_documentation: RESOURCE_DOCUMENTATION_URL,
    });
  });

  // ─── RFC 8414: Authorization Server Metadata ──────────────────────────
  app.get(WELL_KNOWN_AUTHORIZATION_SERVER, (req, res) => {
    applyCorsHeaders(res);
    const issuer = computeIssuer(req, port);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${issuer}${OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${issuer}${OAUTH_REGISTER_PATH}`,
      code_challenge_methods_supported: [...CODE_CHALLENGE_METHODS_SUPPORTED],
      grant_types_supported: [...GRANT_TYPES_SUPPORTED],
      response_types_supported: [...RESPONSE_TYPES_SUPPORTED],
      token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
      scopes_supported: [...WIKIMEM_SCOPES],
    });
  });

  // ─── RFC 7591: Dynamic Client Registration ─────────────────────────────
  app.post(OAUTH_REGISTER_PATH, (req, res) => {
    applyCorsHeaders(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body['redirect_uris']) ? (body['redirect_uris'] as unknown[]) : [];
    const clientName = typeof body['client_name'] === 'string' ? body['client_name'] : 'Unnamed MCP Client';
    const requestedScope = typeof body['scope'] === 'string' ? body['scope'] : WIKIMEM_SCOPES.join(' ');
    const requestedAuthMethod = typeof body['token_endpoint_auth_method'] === 'string'
      ? body['token_endpoint_auth_method']
      : 'none';

    if (redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
      return;
    }

    const normalizedRedirects: string[] = [];
    for (const entry of redirectUris) {
      if (typeof entry !== 'string' || !isValidRedirectUri(entry)) {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'Each redirect_uri must be https, http://127.0.0.1:*, or http://localhost:*',
        });
        return;
      }
      normalizedRedirects.push(entry);
    }

    // OAuth 2.1 public clients via PKCE only. We do not issue secrets.
    if (requestedAuthMethod !== 'none') {
      // Still accept, but force `none` because we don't store/issue secrets.
      // This keeps DCR flexible while preserving the "public client" contract.
    }

    const client: RegisteredClient = {
      client_id: randomBytes(16).toString('hex'),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName.slice(0, 120),
      redirect_uris: normalizedRedirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: requestedScope,
    };
    saveClient(vaultRoot, client);

    res.status(200).json({
      client_id: client.client_id,
      client_id_issued_at: client.client_id_issued_at,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      scope: client.scope,
    });
  });

  // ─── OAuth Authorize Endpoint (GET + POST) ─────────────────────────────
  const autoApprove = process.env['WIKIMEM_OAUTH_AUTO_APPROVE'] === '1';

  app.get(OAUTH_AUTHORIZE_PATH, (req, res) => {
    applyCorsHeaders(res);
    pruneExpiredAuthorizationCodes();
    const query = req.query as Record<string, string | undefined>;
    const responseType = query['response_type'];
    const clientId = query['client_id'];
    const redirectUri = query['redirect_uri'];
    const codeChallenge = query['code_challenge'];
    const codeChallengeMethod = query['code_challenge_method'] ?? 'S256';
    const state = query['state'] ?? '';
    const scope = query['scope'] ?? WIKIMEM_SCOPES.join(' ');
    const issuer = computeIssuer(req, port);
    const resource = query['resource'] ?? resolveCanonicalResource(issuer);

    if (responseType !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type' });
      return;
    }
    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'client_id, redirect_uri, and code_challenge are required' });
      return;
    }
    if (codeChallengeMethod !== 'S256') {
      res.status(400).json({ error: 'invalid_request', error_description: 'Only S256 PKCE is supported' });
      return;
    }
    const client = getClient(vaultRoot, clientId);
    if (!client) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_redirect_uri' });
      return;
    }

    // Auto-approve path — CI/tests skip the consent screen.
    if (autoApprove || hasSessionApproval(clientId)) {
      const code = randomBytes(24).toString('hex');
      saveAuthorizationCode({
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource,
        user_id: 'local',
        expires_at: Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
      });
      recordSessionApproval(clientId);
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      if (state) target.searchParams.set('state', state);
      res.redirect(302, target.toString());
      return;
    }

    const html = renderConsentPage({
      clientName: client.client_name,
      clientId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod,
      state,
      resource,
      formAction: OAUTH_AUTHORIZE_PATH,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  });

  app.post(OAUTH_AUTHORIZE_PATH, (req, res) => {
    applyCorsHeaders(res);
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const clientId = body['client_id'];
    const redirectUri = body['redirect_uri'];
    const codeChallenge = body['code_challenge'];
    const scope = body['scope'] ?? WIKIMEM_SCOPES.join(' ');
    const state = body['state'] ?? '';
    const action = body['action'];
    const issuer = computeIssuer(req, port);
    const resource = body['resource'] ?? resolveCanonicalResource(issuer);

    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const client = getClient(vaultRoot, clientId);
    if (!client) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_redirect_uri' });
      return;
    }

    if (action !== 'allow') {
      const target = new URL(redirectUri);
      target.searchParams.set('error', 'access_denied');
      if (state) target.searchParams.set('state', state);
      res.redirect(302, target.toString());
      return;
    }

    const code = randomBytes(24).toString('hex');
    saveAuthorizationCode({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource,
      user_id: 'local',
      expires_at: Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
    });
    recordSessionApproval(clientId);
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    res.redirect(302, target.toString());
  });

  // ─── OAuth Token Endpoint ──────────────────────────────────────────────
  app.post(OAUTH_TOKEN_PATH, (req, res) => {
    applyCorsHeaders(res);
    pruneExpiredAuthorizationCodes();
    pruneExpiredRefreshTokens();
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const grantType = body['grant_type'];
    const issuer = computeIssuer(req, port);
    const canonicalResource = resolveCanonicalResource(issuer);
    const secret = getOrCreateOAuthSecret(vaultRoot);

    if (grantType === 'authorization_code') {
      const code = body['code'];
      const clientId = body['client_id'];
      const codeVerifier = body['code_verifier'];
      const redirectUri = body['redirect_uri'];
      const requestedResource = body['resource'] ?? canonicalResource;
      if (!code || !clientId || !codeVerifier || !redirectUri) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const entry = consumeAuthorizationCode(code);
      if (!entry) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      if (entry.client_id !== clientId) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        return;
      }
      if (entry.redirect_uri !== redirectUri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      if (!pkceVerifies(codeVerifier, entry.code_challenge)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }

      // Token audience MUST equal the resource advertised in the code exchange.
      // We accept either the code's stored resource or the one on the request.
      const aud = requestedResource || entry.resource || canonicalResource;
      const now = Math.floor(Date.now() / 1000);
      const accessClaims: JwtClaims = {
        iss: issuer,
        sub: entry.user_id,
        aud,
        iat: now,
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
        scope: entry.scope,
        client_id: entry.client_id,
        typ: 'access',
        jti: newJti(),
      };
      const accessToken = signJwt(accessClaims, secret);
      const refreshToken = randomBytes(32).toString('hex');
      saveRefreshToken({
        token: refreshToken,
        client_id: entry.client_id,
        scope: entry.scope,
        resource: aud,
        user_id: entry.user_id,
        expires_at: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      res.status(200).json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: entry.scope,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refresh = body['refresh_token'];
      const clientId = body['client_id'];
      if (!refresh || !clientId) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const existing = consumeRefreshToken(refresh);
      if (!existing) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      if (existing.client_id !== clientId) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const accessClaims: JwtClaims = {
        iss: issuer,
        sub: existing.user_id,
        aud: existing.resource,
        iat: now,
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
        scope: existing.scope,
        client_id: existing.client_id,
        typ: 'access',
        jti: newJti(),
      };
      const accessToken = signJwt(accessClaims, secret);
      const newRefreshToken = randomBytes(32).toString('hex');
      saveRefreshToken({
        token: newRefreshToken,
        client_id: existing.client_id,
        scope: existing.scope,
        resource: existing.resource,
        user_id: existing.user_id,
        expires_at: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      res.status(200).json({
        access_token: accessToken,
        refresh_token: newRefreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: existing.scope,
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}
