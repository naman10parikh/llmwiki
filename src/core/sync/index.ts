/**
 * Sync Coordinator — unified dispatcher for all platform syncs.
 * Reads OAuth tokens from .wikimem/tokens.json and routes to platform-specific sync modules.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncGitHub } from './github.js';
import { syncSlack } from './slack.js';
import { syncGmail } from './gmail.js';
import { syncGDrive } from './gdrive.js';
import { syncLinear } from './linear.js';
import { syncNotion } from './notion.js';
import { syncRss } from './rss.js';
import { syncJira } from './jira.js';

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

export interface TokenStore {
  [provider: string]: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
    connectedAt?: string;
  };
}

// Re-export all sync functions and types
export { syncGitHub, syncSlack, syncGmail, syncGDrive, syncLinear, syncNotion, syncRss, syncJira };
export type { GitHubSyncOptions } from './github.js';
export type { SlackSyncOptions } from './slack.js';
export type { GmailSyncOptions } from './gmail.js';
export type { GDriveSyncOptions } from './gdrive.js';
export type { LinearSyncOptions } from './linear.js';
export type { NotionSyncOptions } from './notion.js';
export type { RssSyncOptions } from './rss.js';
export type { JiraSyncOptions } from './jira.js';
export { SyncScheduler, SCHEDULE_PRESETS } from './scheduler.js';

/**
 * Run sync for an RSS connector by ID. Reads feed URL + topics from connector config.
 */
export async function syncRssConnector(connectorId: string, vaultRoot: string): Promise<PlatformSyncResult> {
  const { existsSync } = await import('node:fs');
  const connectorsPath = join(vaultRoot, '.wikimem-connectors.json');
  if (!existsSync(connectorsPath)) {
    return { provider: 'rss', filesWritten: 0, errors: ['No connectors config found'], duration: 0 };
  }
  const connectors = JSON.parse(readFileSync(connectorsPath, 'utf-8')) as Array<{
    id: string; type: string; name: string; url?: string; topics?: string[];
  }>;
  const connector = connectors.find((c) => c.id === connectorId && c.type === 'rss');
  if (!connector || !connector.url) {
    return { provider: 'rss', filesWritten: 0, errors: [`RSS connector ${connectorId} not found or missing URL`], duration: 0 };
  }
  return syncRss({
    vaultRoot,
    feedUrl: connector.url,
    feedName: connector.name,
    topics: connector.topics,
  });
}

const SUPPORTED_PROVIDERS = ['github', 'slack', 'google', 'gmail', 'gdrive', 'linear', 'notion', 'jira'] as const;
type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

function isSupported(provider: string): provider is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

function readTokens(vaultRoot: string): TokenStore {
  const tokensPath = join(vaultRoot, '.wikimem', 'tokens.json');
  try {
    const raw = readFileSync(tokensPath, 'utf-8');
    return JSON.parse(raw) as TokenStore;
  } catch {
    return {};
  }
}

/**
 * Run sync for a specific provider using stored tokens.
 * 'google' provider maps to Gmail sync (Google OAuth gives gmail+drive access).
 */
export async function syncProvider(provider: string, vaultRoot: string): Promise<PlatformSyncResult> {
  const start = Date.now();

  if (!isSupported(provider)) {
    return {
      provider,
      filesWritten: 0,
      errors: [`Unknown provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`],
      duration: Date.now() - start,
    };
  }

  const tokens = readTokens(vaultRoot);
  // 'gmail' and 'gdrive' both use the 'google' OAuth token
  const tokenKey = (provider === 'gmail' || provider === 'gdrive') ? 'google' : provider;
  const tokenEntry = tokens[tokenKey];

  if (!tokenEntry?.access_token) {
    return {
      provider,
      filesWritten: 0,
      errors: [`No token found for provider "${provider}". Run OAuth flow first.`],
      duration: Date.now() - start,
    };
  }

  const token = tokenEntry.access_token;

  switch (provider) {
    case 'github':
      return syncGitHub({ token, vaultRoot });
    case 'slack':
      return syncSlack({ token, vaultRoot });
    case 'google':
    case 'gmail':
      return syncGmail({ token, vaultRoot });
    case 'gdrive':
      return syncGDrive({ token, vaultRoot });
    case 'linear':
      return syncLinear({ token, vaultRoot });
    case 'notion':
      return syncNotion({ token, vaultRoot });
    case 'jira':
      return syncJira({ token, vaultRoot });
    default:
      return { provider, filesWritten: 0, errors: ['Unreachable'], duration: Date.now() - start };
  }
}
