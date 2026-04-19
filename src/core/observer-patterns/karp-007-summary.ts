/**
 * KARP-007 — Wiki-wide summary (INDEX.md)
 *
 * Generates/refreshes `<wikiRoot>/wiki/INDEX.md` with:
 *   - Total pages & category breakdown
 *   - Top 10 topics by wikilink in-degree
 *   - 3-sentence "state of the wiki" (LLM, cached via content hash)
 *   - Last N changes list (from git log or mtime)
 *
 * Budget: 1 LLM call per run, skipped when wiki-state hash is unchanged.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import { readWikiPage } from '../vault.js';
import type { LLMProvider } from '../../providers/types.js';

export interface WikiSummaryResult {
  indexPath: string;
  pagesTotal: number;
  categoriesCount: number;
  topTopics: Array<{ slug: string; title: string; inDegree: number }>;
  stateOfWiki: string;
  lastChanges: Array<{ page: string; title: string; mtime: string }>;
  llmCalls: number;
  llmCached: boolean;
  durationMs: number;
  hash: string;
}

interface CachedSummary {
  hash: string;
  stateOfWiki: string;
  generatedAt: string;
}

function computeStateHash(pagePaths: string[]): string {
  const h = createHash('sha256');
  h.update(`pages:${pagePaths.length}|`);
  for (const p of pagePaths.slice().sort()) {
    try {
      const m = statSync(p);
      h.update(`${basename(p)}:${m.size}:${m.mtimeMs | 0}|`);
    } catch { /* skip */ }
  }
  return h.digest('hex').slice(0, 16);
}

function loadCache(vaultRoot: string): CachedSummary | null {
  const path = join(vaultRoot, '.wikimem', 'wiki-summary-cache.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CachedSummary;
  } catch { return null; }
}

function saveCache(vaultRoot: string, cache: CachedSummary): void {
  const dir = join(vaultRoot, '.wikimem');
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'wiki-summary-cache.json'),
    JSON.stringify(cache, null, 2),
    'utf-8',
  );
}

function countCategories(pagePaths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const cat = String(page.frontmatter['category'] ?? 'uncategorized');
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    } catch { /* skip */ }
  }
  return counts;
}

function topByInDegree(
  pagePaths: string[],
  incoming: Map<string, number>,
  limit = 10,
): Array<{ slug: string; title: string; inDegree: number }> {
  const result: Array<{ slug: string; title: string; inDegree: number }> = [];
  for (const p of pagePaths) {
    try {
      const slug = basename(p, '.md');
      if (slug === 'INDEX' || slug === 'index' || slug === 'log') continue;
      const page = readWikiPage(p);
      result.push({ slug, title: page.title, inDegree: incoming.get(slug) ?? 0 });
    } catch { /* skip */ }
  }
  return result.sort((a, b) => b.inDegree - a.inDegree).slice(0, limit);
}

function lastChanges(
  pagePaths: string[],
  limit = 10,
): Array<{ page: string; title: string; mtime: string }> {
  const items: Array<{ page: string; title: string; mtime: string; ts: number }> = [];
  for (const p of pagePaths) {
    try {
      const stat = statSync(p);
      const page = readWikiPage(p);
      items.push({
        page: p,
        title: page.title,
        mtime: stat.mtime.toISOString().slice(0, 10),
        ts: stat.mtimeMs,
      });
    } catch { /* skip */ }
  }
  return items
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map(({ page, title, mtime }) => ({ page, title, mtime }));
}

async function generateStateSentence(
  provider: LLMProvider,
  pagesTotal: number,
  categoriesCount: number,
  topTopics: Array<{ title: string; inDegree: number }>,
): Promise<string> {
  const topicList = topTopics
    .slice(0, 8)
    .map((t) => `${t.title} (${t.inDegree})`)
    .join(', ');
  const prompt = `Write EXACTLY 3 sentences describing the state of a knowledge wiki with these facts:
- ${pagesTotal} pages across ${categoriesCount} categories
- Top topics by inbound-link count: ${topicList}

Be concise, factual, informative. No meta commentary. Reply with only the 3 sentences.`;
  try {
    const response = await provider.chat(
      [{ role: 'user', content: prompt }],
      { maxTokens: 200, temperature: 0.3 },
    );
    return response.content.trim();
  } catch {
    return `Wiki contains ${pagesTotal} pages across ${categoriesCount} categories. Key topics include ${topTopics.slice(0, 3).map((t) => t.title).join(', ')}. Generated summary was unavailable this run.`;
  }
}

function renderIndex(result: WikiSummaryResult, categoryCounts: Map<string, number>): string {
  const now = new Date().toISOString().slice(0, 10);
  const categoryLines = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `- **${cat}**: ${n}`)
    .join('\n');
  const topicLines = result.topTopics
    .map((t) => `- [[${t.title}]] — ${t.inDegree} inbound link${t.inDegree === 1 ? '' : 's'}`)
    .join('\n');
  const changeLines = result.lastChanges
    .map((c) => `- [[${c.title}]] — updated ${c.mtime}`)
    .join('\n');
  return `---
title: "Wiki INDEX"
type: index
generated: "${now}"
pagesTotal: ${result.pagesTotal}
---

# Wiki INDEX

_Auto-generated by WikiMem observer (KARP-007). Do not edit by hand — it will be overwritten._

## State of the Wiki

${result.stateOfWiki}

## Categories

${categoryLines || '_No categorized pages yet._'}

## Top 10 Topics (by inbound wikilinks)

${topicLines || '_No linked topics yet._'}

## Recent Changes

${changeLines || '_No recent changes._'}
`;
}

export interface Karp007Options {
  dryRun?: boolean;
  providerFactory?: () => Promise<LLMProvider | null>;
}

export async function runKarp007(
  vaultRoot: string,
  wikiDir: string,
  pagePaths: string[],
  incoming: Map<string, number>,
  options: Karp007Options = {},
): Promise<WikiSummaryResult> {
  const started = Date.now();
  process.stderr.write(`[KARP-007] building wiki summary (${pagePaths.length} pages)...\n`);

  const stateHash = computeStateHash(pagePaths);
  const cached = loadCache(vaultRoot);
  const topicsList = topByInDegree(pagePaths, incoming, 10);
  const changesList = lastChanges(pagePaths, 10);
  const categoryCounts = countCategories(pagePaths);

  let stateOfWiki = '';
  let llmCalls = 0;
  let llmCached = false;

  if (cached && cached.hash === stateHash) {
    stateOfWiki = cached.stateOfWiki;
    llmCached = true;
    process.stderr.write(`[KARP-007] cache hit (hash ${stateHash}) — skipping LLM\n`);
  } else {
    const provider = options.providerFactory
      ? await options.providerFactory()
      : await resolveProvider(vaultRoot);
    if (provider) {
      llmCalls = 1;
      process.stderr.write(`[KARP-007] LLM call 1 for state-of-wiki sentence\n`);
      stateOfWiki = await generateStateSentence(
        provider,
        pagePaths.length,
        categoryCounts.size,
        topicsList,
      );
    } else {
      stateOfWiki = `Wiki contains ${pagePaths.length} pages across ${categoryCounts.size} categories.`;
    }
    if (!options.dryRun) {
      saveCache(vaultRoot, {
        hash: stateHash,
        stateOfWiki,
        generatedAt: new Date().toISOString(),
      });
    }
  }

  const result: WikiSummaryResult = {
    indexPath: join(wikiDir, 'INDEX.md'),
    pagesTotal: pagePaths.length,
    categoriesCount: categoryCounts.size,
    topTopics: topicsList,
    stateOfWiki,
    lastChanges: changesList,
    llmCalls,
    llmCached,
    durationMs: Date.now() - started,
    hash: stateHash,
  };

  if (!options.dryRun) {
    writeFileSync(result.indexPath, renderIndex(result, categoryCounts), 'utf-8');
  }

  return result;
}

/** Load INDEX.md content for API return. */
export function readIndexContent(wikiDir: string): string | null {
  const p = join(wikiDir, 'INDEX.md');
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** Parse INDEX.md and return body (content after frontmatter). */
export function parseIndex(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const parsed = matter(raw);
  return { frontmatter: parsed.data, body: parsed.content };
}

async function resolveProvider(vaultRoot: string): Promise<LLMProvider | null> {
  try {
    const { loadConfig } = await import('../config.js');
    const { createProviderFromUserConfig } = await import('../../providers/index.js');
    const configPath = join(vaultRoot, '.wikimem', 'config.yaml');
    const userConfig = loadConfig(existsSync(configPath) ? configPath : '');
    return createProviderFromUserConfig(userConfig);
  } catch {
    return null;
  }
}
