/**
 * Shared filter and preview types for all sync modules.
 * Prevents downloading everything on first connect.
 */

/** Universal filter parameters accepted by all sync functions */
export interface SyncFilters {
  /** Maximum number of items to sync. Overrides per-provider defaults. */
  maxItems?: number;
  /** ISO date string — only sync items created/updated after this date */
  since?: string;
  /** Free-text search query applied at the API level where supported */
  query?: string;
  /** When true, return metadata about what WOULD be synced without writing files */
  preview?: boolean;

  // ── Provider-specific filters ──
  /** Gmail: only sync threads with these label IDs */
  labels?: string[];
  /** Slack: only sync these channel IDs or names */
  channels?: string[];
  /** GitHub: only sync these repos (owner/name format) */
  repos?: string[];
  /** Jira: only sync issues from these project keys */
  projectKeys?: string[];
  /** Notion: only sync from these database IDs */
  databaseIds?: string[];
  /** Google Drive: restrict to this folder ID */
  folderId?: string;
  /** RSS: keyword topic guardrails */
  topics?: string[];
}

/** A single item that would be synced — returned in preview mode */
export interface PreviewItem {
  id: string;
  title: string;
  /** ISO date string */
  date: string;
  /** Provider-specific type (thread, channel, repo, issue, page, etc.) */
  type: string;
  /** Rough size estimate in characters */
  sizeEstimate: number;
  /** Additional metadata */
  meta?: Record<string, string | number | boolean>;
}

/** Result of a preview call — shows what would be synced */
export interface SyncPreviewResult {
  provider: string;
  /** Total items available matching filters */
  totalItems: number;
  /** Items that would be synced (respecting maxItems cap) */
  items: PreviewItem[];
  /** Estimated LLM tokens for ingesting all items */
  estimatedTokens: number;
  /** Human-readable cost estimate */
  costEstimate: string;
  /** Errors encountered during preview */
  errors: string[];
}

/**
 * Estimate LLM tokens from character count.
 * Rule of thumb: ~4 characters per token for English text.
 * Adds 200 tokens overhead per item for frontmatter/system prompt.
 */
export function estimateTokens(totalChars: number, itemCount: number): number {
  const contentTokens = Math.ceil(totalChars / 4);
  const overhead = itemCount * 200;
  return contentTokens + overhead;
}

/**
 * Format token count as a human-readable cost string.
 * Based on Claude Sonnet input pricing (~$3/1M tokens).
 */
export function formatCostEstimate(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens (< $0.01)`;
  if (tokens < 1_000_000) return `~${Math.round(tokens / 1000)}K tokens (~$${(tokens * 3 / 1_000_000).toFixed(2)})`;
  return `~${(tokens / 1_000_000).toFixed(1)}M tokens (~$${(tokens * 3 / 1_000_000).toFixed(2)})`;
}

/** Check if a date string is after the 'since' filter */
export function isAfterSince(dateStr: string, since: string | undefined): boolean {
  if (!since) return true;
  try {
    return new Date(dateStr).getTime() >= new Date(since).getTime();
  } catch {
    return true; // if date parsing fails, include the item
  }
}
