/**
 * Sync Coordinator — unified dispatcher for all platform syncs.
 * Reads OAuth tokens from .wikimem/tokens.json and routes to platform-specific sync modules.
 * Supports filters (maxItems, since, query, etc.) and preview mode.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncGitHub, previewGitHub } from './github.js';
import { syncSlack, previewSlack } from './slack.js';
import { syncGmail, previewGmail } from './gmail.js';
import { syncGDrive, previewGDrive } from './gdrive.js';
import { syncLinear, previewLinear } from './linear.js';
import { syncNotion, previewNotion } from './notion.js';
import { syncRss, previewRss } from './rss.js';
import { syncJira, previewJira } from './jira.js';
import { syncDiscord, previewDiscord } from './discord.js';
import type { SyncFilters, SyncPreviewResult } from './sync-filters.js';

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

// Re-export all sync functions, preview functions, and types
export { syncGitHub, syncSlack, syncGmail, syncGDrive, syncLinear, syncNotion, syncRss, syncJira, syncDiscord };
export { previewGitHub, previewSlack, previewGmail, previewGDrive, previewLinear, previewNotion, previewRss, previewJira, previewDiscord };
export type { GitHubSyncOptions } from './github.js';
export type { SlackSyncOptions } from './slack.js';
export type { GmailSyncOptions } from './gmail.js';
export type { GDriveSyncOptions } from './gdrive.js';
export type { LinearSyncOptions } from './linear.js';
export type { NotionSyncOptions } from './notion.js';
export type { RssSyncOptions } from './rss.js';
export type { JiraSyncOptions } from './jira.js';
export type { DiscordSyncOptions } from './discord.js';
export type { SyncFilters, SyncPreviewResult, PreviewItem } from './sync-filters.js';
export { estimateTokens, formatCostEstimate } from './sync-filters.js';
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

const SUPPORTED_PROVIDERS = ['github', 'slack', 'google', 'gmail', 'gdrive', 'linear', 'notion', 'jira', 'discord'] as const;
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
 * Accepts optional filters to control what gets synced.
 */
export async function syncProvider(provider: string, vaultRoot: string, filters?: SyncFilters): Promise<PlatformSyncResult> {
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
      return syncGitHub({ token, vaultRoot, filters });
    case 'slack':
      return syncSlack({ token, vaultRoot, filters });
    case 'google':
    case 'gmail':
      return syncGmail({ token, vaultRoot, filters });
    case 'gdrive':
      return syncGDrive({ token, vaultRoot, filters });
    case 'linear':
      return syncLinear({ token, vaultRoot, filters });
    case 'notion':
      return syncNotion({ token, vaultRoot, filters });
    case 'jira':
      return syncJira({ token, vaultRoot, filters });
    case 'discord':
      return syncDiscord({ botToken: token, vaultRoot, filters });
    default:
      return { provider, filesWritten: 0, errors: ['Unreachable'], duration: Date.now() - start };
  }
}

/**
 * Preview what would be synced for a specific provider without writing files.
 * Returns item metadata, counts, and cost estimates for the resource picker UI.
 */
export async function previewProvider(provider: string, vaultRoot: string, filters?: SyncFilters): Promise<SyncPreviewResult> {
  if (!isSupported(provider)) {
    return {
      provider,
      totalItems: 0,
      items: [],
      estimatedTokens: 0,
      costEstimate: '0 tokens',
      errors: [`Unknown provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`],
    };
  }

  const tokens = readTokens(vaultRoot);
  const tokenKey = (provider === 'gmail' || provider === 'gdrive') ? 'google' : provider;
  const tokenEntry = tokens[tokenKey];

  if (!tokenEntry?.access_token) {
    return {
      provider,
      totalItems: 0,
      items: [],
      estimatedTokens: 0,
      costEstimate: '0 tokens',
      errors: [`No token found for provider "${provider}". Run OAuth flow first.`],
    };
  }

  const token = tokenEntry.access_token;
  const f = filters ?? {};

  switch (provider) {
    case 'github':
      return previewGitHub({ token, vaultRoot, filters: f });
    case 'slack':
      return previewSlack({ token, vaultRoot, filters: f });
    case 'google':
    case 'gmail':
      return previewGmail({ token, vaultRoot, filters: f });
    case 'gdrive':
      return previewGDrive({ token, vaultRoot, filters: f });
    case 'linear':
      return previewLinear({ token, vaultRoot, filters: f });
    case 'notion':
      return previewNotion({ token, vaultRoot, filters: f });
    case 'jira':
      return previewJira({ token, vaultRoot, filters: f });
    case 'discord':
      return previewDiscord({ botToken: token, vaultRoot, filters: f });
    default:
      return { provider, totalItems: 0, items: [], estimatedTokens: 0, costEstimate: '0 tokens', errors: ['Unreachable'] };
  }
}
