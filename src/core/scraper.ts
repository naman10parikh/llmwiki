/**
 * Automation 1: Smart Sourcing
 *
 * Full-pipeline scraper that:
 * - Fetches RSS feeds and web pages
 * - Applies topic guardrails (keyword matching)
 * - Labels content as addedBy: 'agent'
 * - Runs ingest pipeline on discovered content
 * - Records every action in the audit trail
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultConfig } from './vault.js';
import { slugify } from './vault.js';
import type { UserConfig, SourceConfig } from './config.js';
import { appendAuditEntry } from './audit-trail.js';

export interface ScraperOptions {
  /** Skip ingest pipeline — only deposit files to raw/ */
  dryRun?: boolean;
  /** Limit items per source (default: 10) */
  maxItems?: number;
  /** Override topic guardrails for this run */
  skipGuardrails?: boolean;
}

export interface ScrapeAction {
  timestamp: string;
  sourceUrl: string;
  sourceName: string;
  itemTitle: string;
  itemUrl: string;
  deposited: boolean;
  ingested: boolean;
  skippedReason?: string;
}

export interface SmartScrapeResult {
  sourcesProcessed: number;
  filesDeposited: number;
  pagesCreated: number;
  actions: ScrapeAction[];
}

// ─── Topic Guardrails ────────────────────────────────────────────────────────

/**
 * Returns true if the content matches the source's topic keywords.
 * If no topics configured, all items pass.
 */
function passesGuardrails(
  title: string,
  content: string,
  source: SourceConfig,
  skipGuardrails = false,
): boolean {
  if (skipGuardrails) return true;
  const topics: string[] = (source as SourceConfig & { topics?: string[] }).topics ?? [];
  if (topics.length === 0) return true;

  const haystack = `${title} ${content}`.toLowerCase();
  return topics.some((kw) => haystack.includes(kw.toLowerCase()));
}

// ─── RSS Connector ───────────────────────────────────────────────────────────

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  return items.map((item) => ({
    title: stripCdata(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'Untitled').trim(),
    link: (item.match(/<link>\s*([\s\S]*?)\s*<\/link>/)?.[1] ?? '').trim(),
    description: stripCdata(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ''),
    pubDate: item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? '',
  }));
}

async function fetchRssFeed(source: SourceConfig, options: ScraperOptions): Promise<RssItem[]> {
  if (!source.url) return [];
  const res = await fetch(source.url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${source.url}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  return items.slice(0, options.maxItems ?? 10);
}

// ─── Web Scraper ─────────────────────────────────────────────────────────────

async function fetchPageContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'WikiMem/0.6 (knowledge-base-bot)' },
    });
    if (!res.ok) return '';
    const html = await res.text();
    // Strip scripts/styles first, then all tags
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .substring(0, 8000);
    return cleaned;
  } catch {
    return '';
  }
}

// ─── Main Scraper Entry Point ─────────────────────────────────────────────────

export async function runSmartScraper(
  config: VaultConfig,
  userConfig: UserConfig,
  options: ScraperOptions = {},
  specificSource?: string,
): Promise<SmartScrapeResult> {
  const sources = userConfig.sources ?? [];
  const toProcess = specificSource
    ? sources.filter((s) => s.name === specificSource)
    : sources;

  const now = new Date().toISOString().split('T')[0] ?? '';
  const dateDir = join(config.rawDir, now);
  mkdirSync(dateDir, { recursive: true });

  const allActions: ScrapeAction[] = [];
  let totalDeposited = 0;
  let totalPagesCreated = 0;
  const startMs = Date.now();

  for (const source of toProcess) {
    const sourceActions = await processSource(source, config, userConfig, dateDir, now, options);
    for (const a of sourceActions.actions) {
      allActions.push(a);
      if (a.deposited) totalDeposited++;
      totalPagesCreated += sourceActions.pagesCreated;
    }
  }

  // Record in audit trail
  appendAuditEntry(config.root, {
    action: 'scrape',
    actor: 'agent',
    source: toProcess.map((s) => s.url ?? s.name).join(', '),
    summary: `Smart scraper ran against ${toProcess.length} source(s). Deposited ${totalDeposited} files, created ${totalPagesCreated} pages.`,
    pagesAffected: allActions.filter((a) => a.ingested).map((a) => a.itemTitle),
    duration: Date.now() - startMs,
  });

  return {
    sourcesProcessed: toProcess.length,
    filesDeposited: totalDeposited,
    pagesCreated: totalPagesCreated,
    actions: allActions,
  };
}

interface SourceRunResult {
  actions: ScrapeAction[];
  pagesCreated: number;
}

async function processSource(
  source: SourceConfig,
  config: VaultConfig,
  userConfig: UserConfig,
  dateDir: string,
  now: string,
  options: ScraperOptions,
): Promise<SourceRunResult> {
  const actions: ScrapeAction[] = [];
  let pagesCreated = 0;

  try {
    if (source.type === 'rss') {
      const items = await fetchRssFeed(source, options);

      for (const item of items) {
        const action: ScrapeAction = {
          timestamp: new Date().toISOString(),
          sourceUrl: source.url ?? '',
          sourceName: source.name,
          itemTitle: item.title,
          itemUrl: item.link,
          deposited: false,
          ingested: false,
        };

        // Fetch full page content for guardrail check
        const fullContent = item.link ? await fetchPageContent(item.link) : item.description;
        const combinedText = `${item.title} ${item.description} ${fullContent}`;

        if (!passesGuardrails(item.title, combinedText, source, options.skipGuardrails)) {
          action.skippedReason = 'Topic guardrail: no keyword match';
          actions.push(action);
          continue;
        }

        // Build markdown content
        const markdown = buildArticleMarkdown(item.title, item.link, source.name, item.description, fullContent, item.pubDate);
        const fileName = `${slugify(item.title.substring(0, 60))}.md`;
        const filePath = join(dateDir, fileName);
        writeFileSync(filePath, markdown, 'utf-8');
        action.deposited = true;

        // Run ingest pipeline unless dry-run
        if (!options.dryRun) {
          try {
            const result = await ingestFile(filePath, config, userConfig);
            pagesCreated += result.pagesCreated;
            action.ingested = true;
          } catch (err) {
            action.skippedReason = `Ingest failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        actions.push(action);
      }
    } else if (source.type === 'url') {
      const action: ScrapeAction = {
        timestamp: new Date().toISOString(),
        sourceUrl: source.url ?? '',
        sourceName: source.name,
        itemTitle: source.name,
        itemUrl: source.url ?? '',
        deposited: false,
        ingested: false,
      };

      const content = await fetchPageContent(source.url ?? '');
      if (!passesGuardrails(source.name, content, source, options.skipGuardrails)) {
        action.skippedReason = 'Topic guardrail: no keyword match';
        actions.push(action);
      } else {
        const markdown = `# ${source.name}\n\nSource: ${source.url}\nScraped: ${new Date().toISOString()}\n\n${content}`;
        const fileName = `${slugify(source.name)}.md`;
        const filePath = join(dateDir, fileName);
        writeFileSync(filePath, markdown, 'utf-8');
        action.deposited = true;

        if (!options.dryRun) {
          try {
            const result = await ingestFile(filePath, config, userConfig);
            pagesCreated += result.pagesCreated;
            action.ingested = true;
          } catch (err) {
            action.skippedReason = `Ingest failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        actions.push(action);
      }
    }
  } catch (err) {
    // Source-level failure — log but don't crash
    const errMsg = err instanceof Error ? err.message : String(err);
    actions.push({
      timestamp: new Date().toISOString(),
      sourceUrl: source.url ?? '',
      sourceName: source.name,
      itemTitle: 'Source fetch failed',
      itemUrl: source.url ?? '',
      deposited: false,
      ingested: false,
      skippedReason: errMsg,
    });
  }

  return { actions, pagesCreated };
}

async function ingestFile(
  filePath: string,
  config: VaultConfig,
  userConfig: UserConfig,
): Promise<{ pagesCreated: number }> {
  const { ingestSource } = await import('./ingest.js');
  const { createProvider } = await import('../providers/index.js');
  const provider = createProvider(userConfig.provider ?? 'claude');
  const result = await ingestSource(filePath, config, provider, {
    verbose: false,
    addedBy: 'agent',
  });
  return { pagesCreated: result.pagesUpdated };
}

function buildArticleMarkdown(
  title: string,
  link: string,
  sourceName: string,
  description: string,
  fullContent: string,
  pubDate: string,
): string {
  const parts: string[] = [`# ${title}`, ''];
  if (link) parts.push(`Source: ${link}`);
  if (sourceName) parts.push(`Feed: ${sourceName}`);
  if (pubDate) parts.push(`Published: ${pubDate}`);
  parts.push(`Scraped: ${new Date().toISOString()}`, '');
  if (description) {
    parts.push('## Summary', '', stripHtml(description).substring(0, 500), '');
  }
  if (fullContent) {
    parts.push('## Content', '', fullContent.substring(0, 6000));
  }
  return parts.join('\n');
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}
