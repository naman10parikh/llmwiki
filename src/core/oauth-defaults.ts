/**
 * Bundled OAuth App Credentials for WikiMem
 *
 * WikiMem registers its own OAuth apps on each platform (like Claude, VS Code, gh CLI).
 * Users click "Connect" → consent screen → done. No manual app registration needed.
 *
 * For CLI/desktop apps:
 * - GitHub Device Flow: only client_id needed (public, no secret)
 * - Google "Desktop app": client_id + client_secret (both non-confidential per Google's docs)
 * - Slack/Linear/Jira: client_id + client_secret (shipped in code, overridable via env vars)
 *
 * Resolution order: bundled defaults → env vars → config.yaml
 * Env vars always override bundled defaults (for development/self-hosted).
 */

export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ProviderDefaults {
  /** Standard OAuth credentials (client_id + client_secret) */
  credentials?: OAuthAppCredentials;
  /** GitHub-specific: Device Flow client_id (no secret needed) */
  deviceFlowClientId?: string;
}

// ── Pre-registered WikiMem OAuth app credentials ──
// Register apps and paste credentials here. They ship with the npm package.
// Users can override via WIKIMEM_{PROVIDER}_CLIENT_ID env vars.
const BUNDLED: Record<string, ProviderDefaults> = {
  github: {
    // GitHub OAuth App — Device Flow enabled
    // Register: https://github.com/settings/developers → New OAuth App
    // Homepage URL: https://github.com/naman10parikh/llmwiki
    // Callback URL: http://localhost:3456/api/auth/callback
    // Check "Enable Device Flow"
    // Only client_id needed for device flow (no secret)
    deviceFlowClientId: 'Ov23liPXlZFPixXov4vx',
  },
  google: {
    // Google OAuth — "WikiMem" app registered April 2026
    // Register: https://console.cloud.google.com/apis/credentials
    // Application type: Web application
    // Redirect URI: http://localhost:3456/api/auth/callback
    // Enabled APIs: Gmail API, Google Drive API
    credentials: {
      clientId: '674720069928-2215v7sn3ptoiemlr6uumbs4hfho9i43.apps.googleusercontent.com',
      clientSecret: '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',
    },
  },
  slack: {
    // Slack App "WikiMem" (A0ASAV3KSUA) — registered April 2026
    // OAuth & Permissions → scopes: channels:history, channels:read, users:read
    // Redirect URL: https://localhost:3456/api/auth/callback
    credentials: {
      clientId: '10733160560263.10894989672962',
      clientSecret: '6b11c67059aa07d02c20dedd2d5af7be',
    },
  },
  linear: {
    // Linear OAuth App
    // Register: https://linear.app/settings/api → OAuth Applications → Create new
    // Callback URL: http://localhost:3456/api/auth/callback
    // credentials: { clientId: '...', clientSecret: '...' },
  },
  jira: {
    // Atlassian/Jira OAuth 2.0 App
    // Register: https://developer.atlassian.com/console/myapps/
    // Create → OAuth 2.0 integration
    // Callback URL: http://localhost:3456/api/auth/callback
    // Scopes: read:jira-work, read:jira-user, offline_access
    // credentials: { clientId: '...', clientSecret: '...' },
  },
};

/** Get bundled OAuth credentials for a provider. Returns null if none configured. */
export function getBundledCredentials(provider: string): OAuthAppCredentials | null {
  return BUNDLED[provider]?.credentials ?? null;
}

/** Get bundled GitHub Device Flow client_id. Returns null if none configured. */
export function getBundledDeviceFlowClientId(): string | null {
  return BUNDLED.github?.deviceFlowClientId ?? null;
}

/** Check if a provider has any bundled credentials (standard or device flow). */
export function hasBundledDefaults(provider: string): boolean {
  const p = BUNDLED[provider];
  if (!p) return false;
  if (provider === 'github') return !!(p.deviceFlowClientId || p.credentials);
  return !!p.credentials;
}
