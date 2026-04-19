/**
 * KARP-003 — Auto-categorize
 *
 * Scan all pages; for each page without a `category` frontmatter field
 * (or with `unknown`/`other`), infer a category using cheap BM25-style
 * keyword features. Only fall back to LLM if confidence < 0.65.
 *
 * Target categories (from AGENTS.md schema):
 *   source, entity, concept, synthesis, daily, meeting, project
 *
 * Budget: max 3 LLM calls per run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import matter from 'gray-matter';
import { readWikiPage } from '../vault.js';
import type { LLMProvider } from '../../providers/types.js';

export type Category =
  | 'source'
  | 'entity'
  | 'concept'
  | 'synthesis'
  | 'daily'
  | 'meeting'
  | 'project';

export interface CategoryUpdate {
  page: string;
  newCategory: Category;
  confidence: number;
  method: 'bm25' | 'llm';
}

export interface CategorizeResult {
  pagesScanned: number;
  pagesNeedingCategory: number;
  pagesUpdated: number;
  llmCalls: number;
  durationMs: number;
  updates: CategoryUpdate[];
  /** 0-2 score: fraction of pages with non-null category after run */
  categoryCoverage: number;
  /** Percentage (0-100) of all pages that now have a category */
  coveragePct: number;
}

const ALL_CATEGORIES: Category[] = [
  'source', 'entity', 'concept', 'synthesis', 'daily', 'meeting', 'project',
];

const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  source: ['paper', 'article', 'pdf', 'author', 'publication', 'journal', 'arxiv', 'doi', 'citation', 'abstract', 'published'],
  entity: ['company', 'organization', 'product', 'library', 'framework', 'platform', 'founded', 'headquartered'],
  concept: ['definition', 'principle', 'theory', 'technique', 'approach', 'pattern', 'mechanism'],
  synthesis: ['comparison', 'synthesis', 'overview', 'review', 'analysis', 'versus', 'compared'],
  daily: ['today', 'yesterday', 'diary', 'journal', 'standup', 'morning', 'daily note'],
  meeting: ['meeting', 'attendees', 'agenda', 'minutes', 'action items', 'participants'],
  project: ['milestone', 'deliverable', 'roadmap', 'sprint', 'backlog', 'deadline', 'eta'],
};

const PATH_HINTS: Array<{ pattern: RegExp; category: Category; boost: number }> = [
  { pattern: /\/sources?\//i, category: 'source', boost: 5 },
  { pattern: /\/entities?\//i, category: 'entity', boost: 5 },
  { pattern: /\/concepts?\//i, category: 'concept', boost: 5 },
  { pattern: /\/synthes(i|e)s\//i, category: 'synthesis', boost: 5 },
  { pattern: /\/daily\//i, category: 'daily', boost: 5 },
  { pattern: /\/meetings?\//i, category: 'meeting', boost: 5 },
  { pattern: /\/projects?\//i, category: 'project', boost: 5 },
];

const TYPE_TO_CATEGORY: Record<string, Category> = {
  source: 'source',
  entity: 'entity',
  concept: 'concept',
  synthesis: 'synthesis',
  daily: 'daily',
  meeting: 'meeting',
  project: 'project',
};

function needsCategorize(frontmatter: Record<string, unknown>): boolean {
  const cat = frontmatter['category'];
  if (cat === undefined || cat === null) return true;
  const s = String(cat).toLowerCase().trim();
  return !s || s === 'other' || s === 'unknown' || s === 'uncategorized';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Score each category for a page via path, type, title, body, filename signals. */
function scoreCategories(
  pagePath: string,
  title: string,
  body: string,
  frontmatter: Record<string, unknown>,
): Map<Category, number> {
  const scores = new Map<Category, number>();
  for (const c of ALL_CATEGORIES) scores.set(c, 0);

  for (const hint of PATH_HINTS) {
    if (hint.pattern.test(pagePath)) {
      scores.set(hint.category, (scores.get(hint.category) ?? 0) + hint.boost);
    }
  }

  const type = String(frontmatter['type'] ?? '').toLowerCase().trim();
  const mapped = TYPE_TO_CATEGORY[type];
  if (mapped) scores.set(mapped, (scores.get(mapped) ?? 0) + 4);

  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS) as Array<[Category, string[]]>) {
    for (const kw of kws) {
      if (lowerTitle.includes(kw)) scores.set(cat, (scores.get(cat) ?? 0) + 2);
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'g');
      const bodyHits = (lowerBody.match(re) ?? []).length;
      scores.set(cat, (scores.get(cat) ?? 0) + Math.min(bodyHits, 3));
    }
  }

  const slug = basename(pagePath, '.md');
  if (/^\d{4}-\d{2}-\d{2}/.test(slug)) {
    scores.set('daily', (scores.get('daily') ?? 0) + 5);
  }

  return scores;
}

function pickCategory(
  scores: Map<Category, number>,
): { category: Category | null; confidence: number } {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (!top || top[1] === 0) return { category: null, confidence: 0 };
  const denom = (sorted[0]?.[1] ?? 0) + (sorted[1]?.[1] ?? 0) + (sorted[2]?.[1] ?? 0);
  if (denom === 0) return { category: null, confidence: 0 };
  return { category: top[0], confidence: top[1] / denom };
}

function writeCategoryToPage(pagePath: string, category: Category): void {
  const raw = readFileSync(pagePath, 'utf-8');
  const { data, content } = matter(raw);
  data['category'] = category;
  const output = matter.stringify(content, data);
  writeFileSync(pagePath, output, 'utf-8');
}

/** LLM fallback — one-shot classification for a page. */
async function classifyViaLLM(
  provider: LLMProvider,
  title: string,
  snippet: string,
): Promise<Category | null> {
  const prompt = `Classify this wiki page into ONE category. Reply with EXACTLY one word from this list: source, entity, concept, synthesis, daily, meeting, project.

Title: "${title}"
First 400 chars: ${snippet.slice(0, 400)}

Category:`;
  try {
    const response = await provider.chat(
      [{ role: 'user', content: prompt }],
      { maxTokens: 10, temperature: 0 },
    );
    const text = response.content.trim().toLowerCase();
    for (const c of ALL_CATEGORIES) {
      if (text.startsWith(c) || text === c) return c;
    }
    return null;
  } catch {
    return null;
  }
}

export interface Karp003Options {
  /** Max LLM calls (default 3). */
  maxLlmCalls?: number;
  /** If true, do not write changes to disk. */
  dryRun?: boolean;
  /** Provider factory — deferred so tests can mock. */
  providerFactory?: () => Promise<LLMProvider | null>;
  /** Confidence threshold below which LLM is used (default 0.65). */
  llmThreshold?: number;
}

/**
 * Run KARP-003 pattern across all pages.
 * Fails gracefully — any error per page is logged and skipped.
 */
export async function runKarp003(
  pagePaths: string[],
  options: Karp003Options = {},
): Promise<CategorizeResult> {
  const started = Date.now();
  const maxLlmCalls = options.maxLlmCalls ?? 3;
  const llmThreshold = options.llmThreshold ?? 0.65;
  const updates: CategoryUpdate[] = [];
  let llmCalls = 0;
  let needingCount = 0;
  let pagesWithCategory = 0;
  let providerResolved: LLMProvider | null | undefined = undefined;

  process.stderr.write(`[KARP-003] scanning ${pagePaths.length} pages...\n`);

  // First pass: pick low-confidence (LLM-eligible) candidates for ordering
  interface Candidate {
    path: string;
    title: string;
    body: string;
    scores: Map<Category, number>;
    pick: { category: Category | null; confidence: number };
  }
  const candidates: Candidate[] = [];

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      if (!needsCategorize(page.frontmatter)) {
        pagesWithCategory++;
        continue;
      }
      needingCount++;
      const scores = scoreCategories(p, page.title, page.content, page.frontmatter);
      const pick = pickCategory(scores);
      candidates.push({ path: p, title: page.title, body: page.content, scores, pick });
    } catch {
      /* skip unreadable */
    }
  }

  process.stderr.write(
    `[KARP-003] ${needingCount} needed classification; ${pagesWithCategory} already categorized\n`,
  );

  // Second pass: apply decisions. LLM only for low-confidence.
  for (const cand of candidates) {
    try {
      let chosen: Category | null = cand.pick.category;
      let confidence = cand.pick.confidence;
      let method: 'bm25' | 'llm' = 'bm25';

      if ((chosen === null || confidence < llmThreshold) && llmCalls < maxLlmCalls) {
        if (providerResolved === undefined) {
          providerResolved = options.providerFactory
            ? await options.providerFactory()
            : await resolveProvider(cand.path);
        }
        if (providerResolved) {
          llmCalls++;
          process.stderr.write(
            `[KARP-003] LLM call ${llmCalls}/${maxLlmCalls} for "${cand.title}"\n`,
          );
          const llmCat = await classifyViaLLM(providerResolved, cand.title, cand.body);
          if (llmCat) {
            chosen = llmCat;
            confidence = 1;
            method = 'llm';
          }
        }
      }

      if (chosen && !options.dryRun) {
        writeCategoryToPage(cand.path, chosen);
      }
      if (chosen) {
        updates.push({
          page: cand.path,
          newCategory: chosen,
          confidence: Math.round(confidence * 100) / 100,
          method,
        });
      }
    } catch {
      /* skip errors per-page */
    }
  }

  const totalPages = pagePaths.length;
  const pagesCategorizedAfter = pagesWithCategory + updates.length;
  const coveragePct = totalPages === 0 ? 0 : (pagesCategorizedAfter / totalPages) * 100;
  // Score: 0-2 pts. 100% → 2, 50% → 1, 0% → 0
  const categoryCoverage = Math.round((coveragePct / 50) * 10) / 10;

  return {
    pagesScanned: pagePaths.length,
    pagesNeedingCategory: needingCount,
    pagesUpdated: updates.length,
    llmCalls,
    durationMs: Date.now() - started,
    updates,
    categoryCoverage: Math.min(2, categoryCoverage),
    coveragePct: Math.round(coveragePct * 10) / 10,
  };
}

async function resolveProvider(samplePath: string): Promise<LLMProvider | null> {
  try {
    const { loadConfig } = await import('../config.js');
    const { createProviderFromUserConfig } = await import('../../providers/index.js');
    const configPath = samplePath.includes('.wikimem')
      ? samplePath.split('.wikimem')[0] + '.wikimem/config.yaml'
      : undefined;
    const userConfig = loadConfig(configPath ?? '');
    return createProviderFromUserConfig(userConfig);
  } catch {
    return null;
  }
}
