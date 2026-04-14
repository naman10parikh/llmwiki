/**
 * RSS Feed Sync — fetches RSS/Atom feeds into raw/ for wiki ingest.
 * Connector-style: reads feed URL from config, applies topic guardrails,
 * writes markdown files with frontmatter.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncFilters, SyncPreviewResult, PreviewItem } from './sync-filters.js';
import { estimateTokens, formatCostEstimate, isAfterSince } from './sync-filters.js';

export interface RssSyncOptions {
  vaultRoot: string;
  feedUrl: string;
  feedName: string;
  topics?: string[];   // keyword guardrails — items must match at least one
  maxItems?: number;    // default 20
  /** Sync filter overrides */
  filters?: SyncFilters;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

const MAX_PAGE_CONTENT_BYTES = 6 * 1024;
const FEED_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 15_000;

// ─── XML Helpers ────────────────────────────────────────────────────────────

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(xml);
  return match ? stripCdata(match[1] ?? '').trim() : '';
}

function extractAtomLink(xml: string): string {
  // Atom <link href="..." /> or <link href="..." rel="alternate" />
  const altMatch = /< link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(xml);
  if (altMatch) return altMatch[1] ?? '';
  const hrefMatch = /<link[^>]*href\s*=\s*["']([^"']+)["']/i.exec(xml);
  return hrefMatch ? (hrefMatch[1] ?? '') : '';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ─── Feed Parsing ───────────────────────────────────────────────────────────

function parseRss2Items(xml: string): FeedItem[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return items.map((block) => ({
    title: stripHtml(extractTag(block, 'title')),
    link: extractTag(block, 'link'),
    description: stripHtml(extractTag(block, 'description')),
    pubDate: extractTag(block, 'pubDate'),
  }));
}

function parseAtomEntries(xml: string): FeedItem[] {
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return entries.map((block) => ({
    title: stripHtml(extractTag(block, 'title')),
    link: extractAtomLink(block),
    description: stripHtml(extractTag(block, 'summary') || extractTag(block, 'content')),
    pubDate: extractTag(block, 'updated') || extractTag(block, 'published'),
  }));
}

function parseFeed(xml: string): FeedItem[] {
  // Detect Atom vs RSS 2.0
  if (/<feed[\s>]/i.test(xml)) {
    return parseAtomEntries(xml);
  }
  return parseRss2Items(xml);
}

// ─── Topic Guardrails ───────────────────────────────────────────────────────

function passesGuardrails(item: FeedItem, topics: string[]): boolean {
  if (topics.length === 0) return true;
  const haystack = `${item.title} ${item.description}`.toLowerCase();
  return topics.some((kw) => haystack.includes(kw.toLowerCase()));
}

// ─── Page Fetching ──────────────────────────────────────────────────────────

async function fetchPageContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { 'User-Agent': 'WikiMem-RSS-Sync/1.0' },
    });
    if (!res.ok) return '';
    const html = await res.text();
    const stripped = stripHtml(html);
    return stripped.slice(0, MAX_PAGE_CONTENT_BYTES);
  } catch {
    return '';
  }
}

// ─── Sync Entry Point ───────────────────────────────────────────────────────

/** Preview what RSS items would be synced with the given filters */
export async function previewRss(options: RssSyncOptions): Promise<SyncPreviewResult> {
  const { feedUrl, feedName } = options;
  const filters = options.filters ?? {};
  const topics = filters.topics ?? options.topics ?? [];
  const maxItems = filters.maxItems ?? options.maxItems ?? 20;
  const errors: string[] = [];

  let xml: string;
  try {
    const res = await fetch(feedUrl, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { 'User-Agent': 'WikiMem-RSS-Sync/1.0' },
    });
    if (!res.ok) {
      errors.push(`Feed fetch failed: HTTP ${res.status} from ${feedUrl}`);
      return { provider: `rss:${feedName}`, totalItems: 0, items: [], estimatedTokens: 0, costEstimate: '0 tokens', errors };
    }
    xml = await res.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Feed fetch error: ${msg}`);
    return { provider: `rss:${feedName}`, totalItems: 0, items: [], estimatedTokens: 0, costEstimate: '0 tokens', errors };
  }

  const allItems = parseFeed(xml);
  let filtered = allItems.filter((item) => passesGuardrails(item, topics));
  if (filters.since) {
    filtered = filtered.filter((item) => isAfterSince(item.pubDate, filters.since));
  }
  if (filters.query) {
    const q = filters.query.toLowerCase();
    filtered = filtered.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(q));
  }
  const capped = filtered.slice(0, maxItems);

  const items: PreviewItem[] = capped.map((item, idx) => ({
    id: item.link || String(idx),
    title: item.title || 'Untitled',
    date: item.pubDate || new Date().toISOString(),
    type: 'article',
    sizeEstimate: item.description.length + 500,
    meta: { url: item.link },
  }));

  const totalChars = items.reduce((sum, i) => sum + i.sizeEstimate, 0);
  const tokens = estimateTokens(totalChars, items.length);

  return {
    provider: `rss:${feedName}`,
    totalItems: filtered.length,
    items,
    estimatedTokens: tokens,
    costEstimate: formatCostEstimate(tokens),
    errors,
  };
}

export async function syncRss(options: RssSyncOptions): Promise<PlatformSyncResult> {
  const filters = options.filters ?? {};

  // Preview mode
  if (filters.preview) {
    const preview = await previewRss(options);
    return { provider: preview.provider, filesWritten: 0, errors: preview.errors, duration: 0 };
  }

  const { vaultRoot, feedUrl, feedName } = options;
  const topics = filters.topics ?? options.topics ?? [];
  const maxItems = filters.maxItems ?? options.maxItems ?? 20;
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;

  // Build output directory: raw/{YYYY-MM-DD}/
  const dateStr = new Date().toISOString().slice(0, 10);
  const rawDir = join(vaultRoot, 'raw', dateStr);
  mkdirSync(rawDir, { recursive: true });

  // Fetch feed XML
  let xml: string;
  try {
    const res = await fetch(feedUrl, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { 'User-Agent': 'WikiMem-RSS-Sync/1.0' },
    });
    if (!res.ok) {
      errors.push(`Feed fetch failed: HTTP ${res.status} from ${feedUrl}`);
      return { provider: `rss:${feedName}`, filesWritten, errors, duration: Date.now() - start };
    }
    xml = await res.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Feed fetch error: ${msg}`);
    return { provider: `rss:${feedName}`, filesWritten, errors, duration: Date.now() - start };
  }

  // Parse items
  const allItems = parseFeed(xml);
  let filtered = allItems.filter((item) => passesGuardrails(item, topics));
  if (filters.since) {
    filtered = filtered.filter((item) => isAfterSince(item.pubDate, filters.since));
  }
  if (filters.query) {
    const q = filters.query.toLowerCase();
    filtered = filtered.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(q));
  }
  const items = filtered.slice(0, maxItems);

  // Process each item
  for (const item of items) {
    try {
      const slug = slugify(item.title || 'untitled');
      const filename = `rss-${slug}.md`;
      const filepath = join(rawDir, filename);

      // Skip if already synced today
      if (existsSync(filepath)) continue;

      // Optionally fetch full page content
      const pageContent = item.link ? await fetchPageContent(item.link) : '';

      const frontmatter = [
        '---',
        'addedBy: connector',
        'source: rss',
        `feed: "${feedName}"`,
        `url: "${item.link}"`,
        `published: "${item.pubDate}"`,
        `syncedAt: "${new Date().toISOString()}"`,
        '---',
      ].join('\n');

      const body = [
        `# ${item.title}`,
        '',
        item.description,
        '',
        pageContent ? `## Full Content\n\n${pageContent}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      writeFileSync(filepath, `${frontmatter}\n\n${body}\n`, 'utf-8');
      filesWritten++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Item "${item.title}": ${msg}`);
    }
  }

  return {
    provider: `rss:${feedName}`,
    filesWritten,
    errors,
    duration: Date.now() - start,
  };
}
