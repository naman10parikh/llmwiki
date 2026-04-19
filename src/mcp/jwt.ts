/**
 * Minimal HS256 JWT helpers backed by `node:crypto`.
 *
 * We avoid pulling in `jsonwebtoken`/`jose` to keep the install footprint tight.
 * HS256 is sufficient for our single-tenant AS because the issuer and resource
 * are the same process — no cross-party verification of public keys is needed.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  scope: string;
  /** Opaque client identifier this token was issued to. */
  client_id: string;
  /** Token type marker — `access` vs `refresh`. */
  typ: 'access' | 'refresh';
  /** Unique token identifier (random) so we can invalidate specific tokens. */
  jti: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Sign a JWT with HS256 using the provided secret.
 */
export function signJwt(claims: JwtClaims, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const unsigned = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest();
  const signatureB64 = base64UrlEncode(signature);
  return `${unsigned}.${signatureB64}`;
}

export interface JwtVerifyResult {
  valid: boolean;
  claims?: JwtClaims;
  reason?: string;
}

/**
 * Verify a JWT signed with HS256 using the provided secret.
 *
 * Performs signature check, expiry check, and audience check (if provided).
 * Returns `valid: false` with a `reason` rather than throwing so callers can
 * distinguish "no token" from "bad token" without try/catch noise.
 */
export function verifyJwt(
  token: string,
  secret: string,
  expectedAudience?: string,
): JwtVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return { valid: false, reason: 'malformed' };
  }

  const unsigned = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac('sha256', secret).update(unsigned).digest();
  let providedSig: Buffer;
  try {
    providedSig = base64UrlDecode(signatureB64);
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  if (providedSig.length !== expectedSig.length) {
    return { valid: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8')) as JwtClaims;
  } catch {
    return { valid: false, reason: 'bad_payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) {
    return { valid: false, reason: 'expired' };
  }

  if (expectedAudience && claims.aud !== expectedAudience) {
    return { valid: false, reason: 'bad_audience' };
  }

  return { valid: true, claims };
}

/** Generate a cryptographically random JTI. */
export function newJti(): string {
  return randomBytes(16).toString('hex');
}
