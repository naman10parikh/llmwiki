/**
 * Automation 2: Observer (Self-Improvement Engine)
 *
 * Runs nightly at 3am (or on demand) to score every wiki page for quality,
 * find orphans, flag contradictions, identify knowledge gaps, discover
 * unexpected patterns, suggest new pages, and find cross-link opportunities.
 *
 * Open-endedness principles (Jeff Clune):
 *   - Not just fixing known issues but discovering unknown-unknowns
 *   - Gets BETTER over time by learning from its experiment log
 *   - Explains what it found and why it matters
 *
 * Reports saved to .wikimem/observer-reports/YYYY-MM-DD.json
 * Experiment log at .wikimem/observer-experiment-log.json
 * Auto-committed as: wiki: observe: nightly quality scan
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import cron from 'node-cron';
import { listWikiPages, readWikiPage } from './vault.js';
import type { VaultConfig } from './vault.js';
import { appendAuditEntry } from './audit-trail.js';
import { runKarp003 } from './observer-patterns/karp-003-categorize.js';
import type { CategorizeResult } from './observer-patterns/karp-003-categorize.js';
import { runKarp007 } from './observer-patterns/karp-007-summary.js';
import type { WikiSummaryResult } from './observer-patterns/karp-007-summary.js';
import { runKarp010 } from './observer-patterns/karp-010-citations.js';
import type { CitationsResult } from './observer-patterns/karp-010-citations.js';
import { runKarp012 } from './observer-patterns/karp-012-semantic.js';
import type { SemanticResult } from './observer-patterns/karp-012-semantic.js';

/** KARP pattern identifiers (stable strings — used by CLI `--karp` flag + `/api/karp/:pattern`). */
export type KarpPatternName = 'auto-categorize' | 'wiki-summary' | 'citations' | 'semantic';

export interface KarpResults {
  /** KARP-003 — auto-categorize pages missing a `category` frontmatter field. */
  autoCategorize?: CategorizeResult;
  /** KARP-007 — wiki-wide summary (writes `<wikiDir>/INDEX.md`). */
  wikiSummary?: WikiSummaryResult;
  /** KARP-010 — citation scoring of outbound URLs (sets `citationScore` frontmatter). */
  citations?: CitationsResult;
  /** KARP-012 — semantic similarity edges between pages (writes `.wikimem/semantic-edges-cache.json`). */
  semantic?: SemanticResult;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface PageScore {
  page: string;
  title: string;
  score: number;
  maxScore: number;
  breakdown: {
    hasSummary: boolean;
    hasLinksOut: boolean;
    hasLinksIn: boolean;
    wordCount: number;
    hasTags: boolean;
    freshness: number;
    readability: number;
    depth: number;
    crossReferencing: number;
    sourceQuality: number;
  };
  issues: string[];
}

function scoreFreshness(frontmatter: Record<string, unknown>): number {
  const updated = frontmatter['updated'] as string | undefined;
  if (!updated) return 0;
  try {
    const daysSince = (Date.now() - new Date(updated).getTime()) / 86_400_000;
    if (daysSince <= 7) return 3;
    if (daysSince <= 14) return 2;
    if (daysSince <= 30) return 1;
    return 0;
  } catch { return 0; }
}

function scoreReadability(content: string): number {
  let r = 0;
  // Has subheadings (h2/h3)
  if (/^#{2,3}\s/m.test(content)) r++;
  // Has structured paragraphs
  const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);
  if (paragraphs.length >= 3) r++;
  // Has code blocks or lists (structured content)
  if (/```[\s\S]*?```/m.test(content) || /^[-*]\s/m.test(content)) r++;
  return r;
}

/** Depth: how thorough is the page? Checks heading depth, paragraph count, detail signals. */
function scoreDepth(content: string, wordCount: number): number {
  let d = 0;
  // Word count thresholds
  if (wordCount >= 300) d += 2;
  else if (wordCount >= 100) d += 1;
  // Multiple heading levels = structured depth
  const headingLevels = new Set<number>();
  const headingRegex = /^(#{1,6})\s/gm;
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRegex.exec(content)) !== null) {
    headingLevels.add(hMatch[1]!.length);
  }
  if (headingLevels.size >= 2) d++;
  return d;
}

/** Cross-referencing: quality of wikilink integration. */
function scoreCrossReferencing(wikilinks: string[], content: string, incomingLinks: number): number {
  let cr = 0;
  // Outbound diversity
  if (wikilinks.length >= 3) cr++;
  if (wikilinks.length >= 6) cr++;
  // Inbound link richness
  if (incomingLinks >= 3) cr++;
  // Wikilinks embedded in prose (not just a "See also" section)
  const proseLines = content.split('\n').filter(l => !l.startsWith('#') && !l.startsWith('-') && l.trim().length > 20);
  const proseWithLinks = proseLines.filter(l => /\[\[[^\]]+\]\]/.test(l));
  if (proseWithLinks.length >= 2) cr++;
  return cr;
}

/** Source quality: does the page cite where its information comes from? */
function scoreSourceQuality(frontmatter: Record<string, unknown>, content: string): number {
  let sq = 0;
  const sources = frontmatter['sources'] as string[] | undefined;
  if (Array.isArray(sources) && sources.length > 0) sq++;
  // Has inline citations or external links
  if (/https?:\/\/\S+/.test(content)) sq++;
  // Has a confidence score
  if (typeof frontmatter['confidence'] === 'number') sq++;
  return sq;
}

const MAX_SCORE = 24; // expanded from 14

function scorePage(pagePath: string, incomingLinks: Map<string, number>): PageScore {
  const page = readWikiPage(pagePath);
  const slug = basename(pagePath, '.md');
  const issues: string[] = [];

  const hasSummary = Boolean(page.frontmatter['summary'] && String(page.frontmatter['summary']).trim().length > 10);
  const hasLinksOut = page.wikilinks.length > 0;
  const linksIn = incomingLinks.get(slug) ?? 0;
  const hasLinksIn = linksIn > 0;
  const hasTags = Array.isArray(page.frontmatter['tags'])
    ? (page.frontmatter['tags'] as unknown[]).length > 0
    : false;
  const freshness = scoreFreshness(page.frontmatter);
  const readability = scoreReadability(page.content);
  const depth = scoreDepth(page.content, page.wordCount);
  const crossReferencing = scoreCrossReferencing(page.wikilinks, page.content, linksIn);
  const sourceQuality = scoreSourceQuality(page.frontmatter, page.content);

  let score = 0;
  if (hasSummary) score += 2;
  if (hasLinksOut) score += 2;
  if (hasLinksIn) score += 2;
  if (page.wordCount >= 50) score += 2;
  else if (page.wordCount >= 20) score += 1;
  if (hasTags) score += 2;
  score += freshness;   // 0-3
  score += readability;  // 0-3
  score += depth;        // 0-3
  score += crossReferencing; // 0-4
  score += sourceQuality;    // 0-3

  if (!hasSummary) issues.push('Missing or empty summary in frontmatter');
  if (!hasLinksOut) issues.push('No outbound [[wikilinks]] — isolated page');
  if (!hasLinksIn) issues.push('No pages link to this page (orphan candidate)');
  if (page.wordCount < 50) issues.push(`Very short content (${page.wordCount} words)`);
  if (!hasTags) issues.push('No tags defined');
  if (freshness === 0) issues.push('Stale or missing updated date (>30 days)');
  if (readability === 0) issues.push('No headings or structured paragraphs');
  if (depth === 0) issues.push('Shallow content — lacks structural depth');
  if (crossReferencing === 0) issues.push('Poor cross-referencing — few or no contextual links');
  if (sourceQuality === 0) issues.push('No source attribution or citations');

  return {
    page: pagePath,
    title: page.title,
    score,
    maxScore: MAX_SCORE,
    breakdown: {
      hasSummary,
      hasLinksOut,
      hasLinksIn,
      wordCount: page.wordCount,
      hasTags,
      freshness,
      readability,
      depth,
      crossReferencing,
      sourceQuality,
    },
    issues,
  };
}

// ─── Orphan Detection ────────────────────────────────────────────────────────

export interface OrphanPage {
  page: string;
  title: string;
  slug: string;
}

function findOrphans(pagePaths: string[], incomingLinks: Map<string, number>): OrphanPage[] {
  return pagePaths
    .filter((p) => {
      const slug = basename(p, '.md');
      return (incomingLinks.get(slug) ?? 0) === 0;
    })
    .map((p) => {
      const page = readWikiPage(p);
      return { page: p, title: page.title, slug: basename(p, '.md') };
    });
}

// ─── Contradiction Flagging ──────────────────────────────────────────────────

export interface PotentialContradiction {
  pageA: string;
  titleA: string;
  pageB: string;
  titleB: string;
  reason: string;
}

/**
 * Lightweight heuristic: two pages share a topic keyword in their title
 * but their summaries contain opposing sentiment words.
 */
/** Exported for lint + UI — heuristic opposing-summary pairs across related pages */
export function flagContradictions(pagePaths: string[]): PotentialContradiction[] {
  const contradictions: PotentialContradiction[] = [];

  const OPPOSING_PAIRS: Array<[string, string]> = [
    ['deprecated', 'recommended'],
    ['avoid', 'use'],
    ['slow', 'fast'],
    ['removed', 'added'],
    ['disabled', 'enabled'],
    ['legacy', 'modern'],
    ['broken', 'working'],
  ];

  const pages = pagePaths.map((p) => {
    const page = readWikiPage(p);
    const summary = String(page.frontmatter['summary'] ?? '').toLowerCase();
    return { path: p, title: page.title, summary };
  });

  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i]!;
      const b = pages[j]!;

      // Only compare pages that share a word in their title (likely related)
      const wordsA = new Set(a.title.toLowerCase().split(/\s+/));
      const wordsB = new Set(b.title.toLowerCase().split(/\s+/));
      const sharedWords = [...wordsA].filter((w) => w.length > 3 && wordsB.has(w));
      if (sharedWords.length === 0) continue;

      for (const [pos, neg] of OPPOSING_PAIRS) {
        const aHasPos = a.summary.includes(pos) || a.summary.includes(neg);
        const bHasPos = b.summary.includes(pos) || b.summary.includes(neg);
        if (aHasPos && bHasPos) {
          const aWord = a.summary.includes(pos) ? pos : neg;
          const bWord = b.summary.includes(pos) ? pos : neg;
          if (aWord !== bWord) {
            contradictions.push({
              pageA: a.path,
              titleA: a.title,
              pageB: b.path,
              titleB: b.title,
              reason: `"${a.title}" uses "${aWord}" while "${b.title}" uses "${bWord}" for shared topic "${sharedWords[0]}"`,
            });
          }
        }
      }
    }
    // Cap at 50 contradictions to avoid O(n²) blowup on large wikis
    if (contradictions.length >= 50) break;
  }

  return contradictions;
}

// ─── Gap Analysis ─────────────────────────────────────────────────────────────

export interface KnowledgeGap {
  mentionedTopic: string;
  mentionedIn: string[];
  mentionCount: number;
}

/**
 * Find [[wikilinks]] that point to non-existent pages — these are knowledge gaps.
 */
function findGaps(pagePaths: string[]): KnowledgeGap[] {
  const existingSlugs = new Set(pagePaths.map((p) => basename(p, '.md').toLowerCase()));
  const existingTitles = new Set<string>();
  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      existingTitles.add(page.title.toLowerCase());
    } catch { /* skip */ }
  }

  const missing = new Map<string, string[]>();

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      for (const link of page.wikilinks) {
        const slug = link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!existingSlugs.has(slug) && !existingTitles.has(link.toLowerCase())) {
          const refs = missing.get(link) ?? [];
          refs.push(page.title);
          missing.set(link, refs);
        }
      }
    } catch { /* skip unreadable pages */ }
  }

  return Array.from(missing.entries())
    .map(([topic, refs]) => ({
      mentionedTopic: topic,
      mentionedIn: [...new Set(refs)],
      mentionCount: refs.length,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, 50);
}

// ─── Inbound Link Map ─────────────────────────────────────────────────────────

function buildIncomingLinksMap(pagePaths: string[]): Map<string, number> {
  const titleToSlug = new Map<string, string>();

  // Build title → slug lookup
  for (const p of pagePaths) {
    const slug = basename(p, '.md');
    try {
      const page = readWikiPage(p);
      titleToSlug.set(page.title.toLowerCase(), slug);
      titleToSlug.set(slug, slug);
    } catch { /* skip */ }
  }

  const incoming = new Map<string, number>();

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      for (const link of page.wikilinks) {
        const slug =
          titleToSlug.get(link.toLowerCase()) ??
          titleToSlug.get(link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        if (slug) {
          incoming.set(slug, (incoming.get(slug) ?? 0) + 1);
        }
      }
    } catch { /* skip */ }
  }

  return incoming;
}

// ─── Open-Ended Discovery ────────────────────────────────────────────────────

export interface UnexpectedPattern {
  type: 'isolated-cluster' | 'topic-conflict' | 'missing-connection' | 'stale-hub' | 'tag-orphan';
  description: string;
  pages: string[];
  significance: 'low' | 'medium' | 'high';
}

/**
 * Discover unexpected patterns — things the wiki doesn't know it doesn't know.
 * Goes beyond fixing known issues to find structural anomalies.
 */
function discoverUnexpected(
  pagePaths: string[],
  incomingLinks: Map<string, number>,
): UnexpectedPattern[] {
  const patterns: UnexpectedPattern[] = [];
  const pageDataCache: Array<{ path: string; slug: string; title: string; tags: string[]; wikilinks: string[]; wordCount: number; summary: string; updated: string }> = [];

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      pageDataCache.push({
        path: p,
        slug: basename(p, '.md'),
        title: page.title,
        tags: Array.isArray(page.frontmatter['tags']) ? (page.frontmatter['tags'] as string[]) : [],
        wikilinks: page.wikilinks,
        wordCount: page.wordCount,
        summary: String(page.frontmatter['summary'] ?? ''),
        updated: String(page.frontmatter['updated'] ?? ''),
      });
    } catch { /* skip */ }
  }

  // 1. Isolated clusters: groups of pages that link to each other but not to the rest
  const adjacency = new Map<string, Set<string>>();
  const titleToSlug = new Map<string, string>();
  for (const pd of pageDataCache) {
    titleToSlug.set(pd.title.toLowerCase(), pd.slug);
    titleToSlug.set(pd.slug, pd.slug);
  }

  for (const pd of pageDataCache) {
    const neighbors = new Set<string>();
    for (const link of pd.wikilinks) {
      const target = titleToSlug.get(link.toLowerCase())
        ?? titleToSlug.get(link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
      if (target && target !== pd.slug) neighbors.add(target);
    }
    adjacency.set(pd.slug, neighbors);
  }

  // Find pages with outbound links that only connect within a small group
  for (const pd of pageDataCache) {
    const neighbors = adjacency.get(pd.slug);
    if (!neighbors || neighbors.size < 2) continue;
    // Check if this page's neighbors form a closed clique
    let closedCount = 0;
    for (const n of neighbors) {
      const nNeighbors = adjacency.get(n);
      if (nNeighbors) {
        const outsideLinks = [...nNeighbors].filter(nn => !neighbors.has(nn) && nn !== pd.slug);
        if (outsideLinks.length === 0) closedCount++;
      }
    }
    if (closedCount >= 2 && neighbors.size <= 5) {
      patterns.push({
        type: 'isolated-cluster',
        description: `"${pd.title}" and ${closedCount} neighbors form an isolated cluster with no outbound links to the broader wiki`,
        pages: [pd.slug, ...neighbors],
        significance: 'medium',
      });
    }
    if (patterns.filter(p => p.type === 'isolated-cluster').length >= 5) break;
  }

  // 2. Stale hubs: pages with many incoming links but very old content
  for (const pd of pageDataCache) {
    const inCount = incomingLinks.get(pd.slug) ?? 0;
    if (inCount < 3) continue;
    if (!pd.updated) continue;
    try {
      const daysSince = (Date.now() - new Date(pd.updated).getTime()) / 86_400_000;
      if (daysSince > 60) {
        patterns.push({
          type: 'stale-hub',
          description: `"${pd.title}" has ${inCount} pages linking to it but hasn't been updated in ${Math.round(daysSince)} days — high-impact staleness`,
          pages: [pd.slug],
          significance: 'high',
        });
      }
    } catch { /* skip bad date */ }
    if (patterns.filter(p => p.type === 'stale-hub').length >= 5) break;
  }

  // 3. Tag orphans: tags used by only one page (might be typos or inconsistencies)
  const tagCounts = new Map<string, string[]>();
  for (const pd of pageDataCache) {
    for (const tag of pd.tags) {
      const normalized = tag.toLowerCase().trim();
      if (!normalized) continue;
      const pages = tagCounts.get(normalized) ?? [];
      pages.push(pd.slug);
      tagCounts.set(normalized, pages);
    }
  }
  const singletonTags: Array<{ tag: string; page: string }> = [];
  for (const [tag, pages] of tagCounts) {
    if (pages.length === 1 && pages[0]) {
      singletonTags.push({ tag, page: pages[0] });
    }
  }
  if (singletonTags.length > 0) {
    const topSingletons = singletonTags.slice(0, 10);
    patterns.push({
      type: 'tag-orphan',
      description: `${singletonTags.length} tags used by only one page (possible typos or inconsistencies): ${topSingletons.map(s => `"${s.tag}"`).join(', ')}`,
      pages: topSingletons.map(s => s.page),
      significance: singletonTags.length > 5 ? 'medium' : 'low',
    });
  }

  // 4. Topic conflicts via content overlap: pages with similar word distributions
  //    but different summaries (deeper than just opposing-word heuristic)
  for (let i = 0; i < pageDataCache.length && i < 100; i++) {
    for (let j = i + 1; j < pageDataCache.length && j < 100; j++) {
      const a = pageDataCache[i]!;
      const b = pageDataCache[j]!;
      // Skip if they already link to each other
      const aLinks = adjacency.get(a.slug);
      const bLinks = adjacency.get(b.slug);
      if (aLinks?.has(b.slug) || bLinks?.has(a.slug)) continue;
      // Check if tags overlap significantly
      const sharedTags = a.tags.filter(t => b.tags.includes(t));
      if (sharedTags.length < 2) continue;
      // Summaries differ substantially
      if (a.summary && b.summary && a.summary !== b.summary) {
        patterns.push({
          type: 'topic-conflict',
          description: `"${a.title}" and "${b.title}" share ${sharedTags.length} tags (${sharedTags.join(', ')}) but have different summaries and don't cross-reference each other`,
          pages: [a.slug, b.slug],
          significance: 'medium',
        });
      }
      if (patterns.filter(p => p.type === 'topic-conflict').length >= 10) break;
    }
    if (patterns.filter(p => p.type === 'topic-conflict').length >= 10) break;
  }

  return patterns;
}

// ─── New Page Suggestions ────────────────────────────────────────────────────

export interface PageSuggestion {
  topic: string;
  reason: string;
  referencedBy: string[];
  priority: 'low' | 'medium' | 'high';
}

/**
 * Suggest new pages the wiki should have. Goes beyond gap analysis (broken links)
 * to identify conceptual gaps — topics heavily discussed but never given their own page.
 */
function suggestNewPages(
  pagePaths: string[],
  gaps: KnowledgeGap[],
): PageSuggestion[] {
  const suggestions: PageSuggestion[] = [];

  // 1. Promote top gaps (broken wikilinks) as high-priority suggestions
  for (const gap of gaps.slice(0, 10)) {
    suggestions.push({
      topic: gap.mentionedTopic,
      reason: `Referenced by ${gap.mentionCount} page(s) via [[wikilink]] but no dedicated page exists`,
      referencedBy: gap.mentionedIn,
      priority: gap.mentionCount >= 3 ? 'high' : 'medium',
    });
  }

  // 2. Concept extraction: find recurring noun phrases across pages that aren't page titles
  const existingTitles = new Set<string>();
  const phraseOccurrences = new Map<string, Set<string>>();

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      existingTitles.add(page.title.toLowerCase());
      existingTitles.add(basename(p, '.md').toLowerCase());

      // Extract capitalized noun phrases (2-3 words) as potential concept names
      const phrases = page.content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) ?? [];
      for (const phrase of phrases) {
        const normalized = phrase.toLowerCase();
        // Skip if it's already a page title or too common
        if (existingTitles.has(normalized)) continue;
        if (normalized.length < 5) continue;
        const sources = phraseOccurrences.get(normalized) ?? new Set();
        sources.add(page.title);
        phraseOccurrences.set(normalized, sources);
      }
    } catch { /* skip */ }
  }

  // Phrases mentioned by 3+ different pages are strong candidates
  const alreadySuggested = new Set(suggestions.map(s => s.topic.toLowerCase()));
  for (const [phrase, sources] of phraseOccurrences) {
    if (sources.size >= 3 && !alreadySuggested.has(phrase)) {
      suggestions.push({
        topic: phrase.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        reason: `Capitalized phrase appearing across ${sources.size} pages — likely a notable concept without its own page`,
        referencedBy: [...sources],
        priority: sources.size >= 5 ? 'high' : 'medium',
      });
    }
    if (suggestions.length >= 30) break;
  }

  // 3. Tag-based suggestions: tags with many pages but no dedicated "overview" page
  const tagPages = new Map<string, string[]>();
  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const tags = Array.isArray(page.frontmatter['tags']) ? (page.frontmatter['tags'] as string[]) : [];
      for (const tag of tags) {
        const normalized = tag.toLowerCase().trim();
        if (!normalized || normalized.length < 3) continue;
        const pages = tagPages.get(normalized) ?? [];
        pages.push(page.title);
        tagPages.set(normalized, pages);
      }
    } catch { /* skip */ }
  }

  for (const [tag, pages] of tagPages) {
    if (pages.length >= 4 && !existingTitles.has(tag) && !alreadySuggested.has(tag)) {
      suggestions.push({
        topic: tag.charAt(0).toUpperCase() + tag.slice(1),
        reason: `Tag "${tag}" is used by ${pages.length} pages but has no overview page — would serve as a hub`,
        referencedBy: pages.slice(0, 5),
        priority: pages.length >= 6 ? 'high' : 'medium',
      });
      alreadySuggested.add(tag);
    }
    if (suggestions.length >= 40) break;
  }

  return suggestions
    .sort((a, b) => {
      const prio = { high: 0, medium: 1, low: 2 };
      return prio[a.priority] - prio[b.priority];
    })
    .slice(0, 30);
}

// ─── Pattern Detection Across Vault ─────────────────────────────────────────

export interface VaultPattern {
  topic: string;
  pageCount: number;
  pages: string[];
  suggestion: string;
}

/**
 * Task 1: Scan for repeated themes across pages. When 3+ pages mention the same
 * topic (by heading keyword or body phrase), suggest creating a dedicated concept page.
 * Writes findings to the experiment log.
 */
function detectVaultPatterns(
  pagePaths: string[],
  existingTitles: Set<string>,
): VaultPattern[] {
  // Extract significant heading-level keywords from each page
  const headingWords = new Map<string, string[]>(); // word → [pageTitles...]

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      // Pull words from all headings (##, ###, etc.)
      const headings = page.content.match(/^#{2,4}\s+(.+)$/gm) ?? [];
      for (const h of headings) {
        const text = h.replace(/^#+\s+/, '').toLowerCase();
        // Split into words of 5+ chars
        const words = text.split(/\W+/).filter(w => w.length >= 5);
        for (const w of words) {
          if (existingTitles.has(w)) continue;
          const refs = headingWords.get(w) ?? [];
          refs.push(page.title);
          headingWords.set(w, refs);
        }
      }
    } catch { /* skip */ }
  }

  const patterns: VaultPattern[] = [];
  for (const [word, pages] of headingWords) {
    const unique = [...new Set(pages)];
    if (unique.length >= 3) {
      const displayTopic = word.charAt(0).toUpperCase() + word.slice(1);
      if (!existingTitles.has(displayTopic.toLowerCase())) {
        patterns.push({
          topic: displayTopic,
          pageCount: unique.length,
          pages: unique.slice(0, 10),
          suggestion: `Create a dedicated "${displayTopic}" concept page — found in headings across ${unique.length} pages`,
        });
      }
    }
  }

  return patterns
    .sort((a, b) => b.pageCount - a.pageCount)
    .slice(0, 20);
}

// ─── Semantic Contradiction Detection ───────────────────────────────────────

export interface SemanticContradiction {
  pageA: string;
  titleA: string;
  snippetA: string;
  pageB: string;
  titleB: string;
  snippetB: string;
  explanation: string;
}

/**
 * Task 2: Use LLM to detect semantic contradictions between pages.
 * Compares summaries of pages that share tags or title words.
 * Budget-gated: max `maxPairs` comparisons.
 */
async function detectSemanticContradictions(
  pagePaths: string[],
  options: ObserverOptions,
  maxPairs = 10,
): Promise<SemanticContradiction[]> {
  const results: SemanticContradiction[] = [];
  if (pagePaths.length < 2) return results;

  // Build candidate pairs: same tag or shared title word
  interface PageMeta {
    path: string;
    title: string;
    tags: string[];
    summary: string;
  }
  const metas: PageMeta[] = [];
  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const summary = String(page.frontmatter['summary'] ?? '').trim();
      if (!summary) continue; // need summaries to compare
      metas.push({
        path: p,
        title: page.title,
        tags: Array.isArray(page.frontmatter['tags']) ? (page.frontmatter['tags'] as string[]) : [],
        summary,
      });
    } catch { /* skip */ }
  }

  // Find candidate pairs by shared tags
  const candidatePairs: Array<[PageMeta, PageMeta]> = [];
  for (let i = 0; i < metas.length; i++) {
    for (let j = i + 1; j < metas.length; j++) {
      const a = metas[i]!;
      const b = metas[j]!;
      const sharedTags = a.tags.filter(t => b.tags.includes(t));
      if (sharedTags.length >= 1) {
        candidatePairs.push([a, b]);
        if (candidatePairs.length >= maxPairs * 3) break; // collect extra, pick below
      }
    }
    if (candidatePairs.length >= maxPairs * 3) break;
  }

  const pairs = candidatePairs.slice(0, maxPairs);
  if (pairs.length === 0) return results;

  try {
    const { loadConfig } = await import('./config.js');
    const { createProviderFromUserConfig } = await import('../providers/index.js');
    const vaultRoot = pagePaths[0] ? pagePaths[0].split('/.wikimem')[0] ?? pagePaths[0].split('/wiki/')[0] ?? '' : '';
    // Determine config path — use first page's vault context
    const configPath = pagePaths[0]?.includes('.wikimem')
      ? pagePaths[0].split('.wikimem')[0] + '.wikimem/config.yaml'
      : undefined;
    const userConfig = loadConfig(configPath ?? '');
    const provider = createProviderFromUserConfig(userConfig);

    for (const [a, b] of pairs) {
      try {
        const prompt = `Do these two wiki page summaries contain semantic contradictions — claims that are incompatible with each other?

Page A: "${a.title}"
Summary A: ${a.summary}

Page B: "${b.title}"
Summary B: ${b.summary}

Reply with EXACTLY one of:
- "NO_CONTRADICTION" — if they are compatible
- "CONTRADICTION: <one sentence explaining the incompatibility>" — if they contradict each other`;

        const response = await provider.chat([
          { role: 'user', content: prompt },
        ], { maxTokens: 150, temperature: 0 });

        const text = response.content.trim();
        if (text.startsWith('CONTRADICTION:')) {
          const explanation = text.slice('CONTRADICTION:'.length).trim();
          results.push({
            pageA: a.path,
            titleA: a.title,
            snippetA: a.summary.slice(0, 200),
            pageB: b.path,
            titleB: b.title,
            snippetB: b.summary.slice(0, 200),
            explanation,
          });
        }
      } catch { /* skip pair on error */ }
    }
  } catch { /* LLM unavailable — return empty */ }

  return results;
}

// ─── Knowledge-Gap Suggestions (Top Missing Wikilinks) ───────────────────────

export interface MissingPageSuggestion {
  title: string;
  occurrences: number;
  referencedBy: string[];
}

/**
 * Task 3: Count wikilink targets that point to non-existent pages.
 * Return top 5 most-referenced missing pages.
 */
function suggestMissingPages(
  pagePaths: string[],
  gaps: KnowledgeGap[],
): MissingPageSuggestion[] {
  // gaps already contains all missing-wikilink data sorted by count
  return gaps.slice(0, 5).map(g => ({
    title: g.mentionedTopic,
    occurrences: g.mentionCount,
    referencedBy: g.mentionedIn,
  }));
}

// ─── Temporal Staleness Scan ─────────────────────────────────────────────────

export interface StalePage {
  page: string;
  title: string;
  daysSinceUpdate: number;
  stalenessScore: number; // higher = more urgent
  signals: string[];
}

/**
 * Task 4: Find pages not updated in 30+ days.
 * Rank by staleness signals: age, incoming links, date references in content.
 */
function scanTemporalStaleness(
  pagePaths: string[],
  incomingLinks: Map<string, number>,
  thresholdDays = 30,
): StalePage[] {
  const stale: StalePage[] = [];
  const now = Date.now();

  // Patterns that suggest time-sensitive content
  const TIME_SIGNALS = [
    /\b(20\d{2})\b/g,              // year mentions
    /\b(Q[1-4]\s+20\d{2})\b/g,     // Q1 2024 style
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}\b/gi,
    /\bversion\s+\d+\.\d+/gi,      // versioned software
    /\bas of\b/gi,                  // "as of" date references
    /\bcurrently\b/gi,              // "currently" implies temporal state
  ];

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const slug = basename(p, '.md');
      const updated = page.frontmatter['updated'] as string | undefined;
      if (!updated) continue;

      let daysSince: number;
      try {
        daysSince = (now - new Date(updated).getTime()) / 86_400_000;
      } catch { continue; }

      if (daysSince < thresholdDays) continue;

      const signals: string[] = [];
      const inCount = incomingLinks.get(slug) ?? 0;

      // Check content for time-sensitive signals
      const lowerContent = page.content.toLowerCase();
      let timeSignalCount = 0;
      for (const pattern of TIME_SIGNALS) {
        pattern.lastIndex = 0;
        const matches = lowerContent.match(pattern);
        if (matches) timeSignalCount += matches.length;
      }

      if (timeSignalCount > 0) signals.push(`${timeSignalCount} temporal references in content`);
      if (inCount >= 3) signals.push(`${inCount} pages link to this (high-impact)`);
      if (page.wordCount > 300) signals.push('substantial page (>300 words)');

      // Staleness score: weight by age, impact (incoming links), and time signals
      const ageFactor = Math.min(daysSince / 365, 1); // cap at 1 year
      const impactFactor = Math.min(inCount / 5, 1);
      const signalFactor = Math.min(timeSignalCount / 10, 1);
      const stalenessScore = Math.round((ageFactor * 0.4 + impactFactor * 0.4 + signalFactor * 0.2) * 100);

      stale.push({
        page: p,
        title: page.title,
        daysSinceUpdate: Math.round(daysSince),
        stalenessScore,
        signals,
      });
    } catch { /* skip */ }
  }

  return stale
    .sort((a, b) => b.stalenessScore - a.stalenessScore)
    .slice(0, 20);
}

// ─── Serendipitous Connection ─────────────────────────────────────────────────

export interface SerendipitousConnection {
  pageA: string;
  titleA: string;
  pageB: string;
  titleB: string;
  connection: string;
}

/**
 * Task 5: Take 2 random pages from different categories/tags.
 * Ask LLM "is there a non-obvious connection?"
 * Writes findings to experiment log.
 * Budget-gated: max `maxAttempts` LLM calls.
 */
async function findSerendipitousConnections(
  pagePaths: string[],
  options: ObserverOptions,
  maxAttempts = 3,
): Promise<SerendipitousConnection[]> {
  const results: SerendipitousConnection[] = [];
  if (pagePaths.length < 4) return results;

  // Group pages by their first tag
  const tagGroups = new Map<string, string[]>();
  const untagged: string[] = [];

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const tags = Array.isArray(page.frontmatter['tags']) ? (page.frontmatter['tags'] as string[]) : [];
      if (tags.length === 0) { untagged.push(p); continue; }
      const group = tagGroups.get(tags[0]!) ?? [];
      group.push(p);
      tagGroups.set(tags[0]!, group);
    } catch { untagged.push(p); }
  }

  // Build pairs from DIFFERENT groups
  const groupKeys = [...tagGroups.keys()];
  if (groupKeys.length < 2) return results;

  const pairs: Array<[string, string]> = [];
  for (let attempt = 0; attempt < maxAttempts * 5 && pairs.length < maxAttempts; attempt++) {
    const idxA = Math.floor(Math.random() * groupKeys.length);
    let idxB = Math.floor(Math.random() * (groupKeys.length - 1));
    if (idxB >= idxA) idxB++;

    const groupA = tagGroups.get(groupKeys[idxA]!)!;
    const groupB = tagGroups.get(groupKeys[idxB]!)!;
    if (!groupA.length || !groupB.length) continue;

    const pageA = groupA[Math.floor(Math.random() * groupA.length)]!;
    const pageB = groupB[Math.floor(Math.random() * groupB.length)]!;
    pairs.push([pageA, pageB]);
  }

  if (pairs.length === 0) return results;

  try {
    const { loadConfig } = await import('./config.js');
    const { createProviderFromUserConfig } = await import('../providers/index.js');
    const configPath = pagePaths[0]?.includes('.wikimem')
      ? pagePaths[0].split('.wikimem')[0] + '.wikimem/config.yaml'
      : undefined;
    const userConfig = loadConfig(configPath ?? '');
    const provider = createProviderFromUserConfig(userConfig);

    for (const [pathA, pathB] of pairs) {
      try {
        const pageA = readWikiPage(pathA);
        const pageB = readWikiPage(pathB);

        // Give LLM a summary + first 300 chars of content for each
        const summA = String(pageA.frontmatter['summary'] ?? pageA.content.slice(0, 300));
        const summB = String(pageB.frontmatter['summary'] ?? pageB.content.slice(0, 300));

        const prompt = `These are two wiki pages from different topic categories. Is there a non-obvious, intellectually interesting connection between them?

Page A: "${pageA.title}"
${summA.slice(0, 300)}

Page B: "${pageB.title}"
${summB.slice(0, 300)}

Reply with EXACTLY one of:
- "NO_CONNECTION" — if there is no meaningful connection
- "CONNECTION: <one concise sentence describing the non-obvious link>" — if there is one`;

        const response = await provider.chat([
          { role: 'user', content: prompt },
        ], { maxTokens: 150, temperature: 0.3 });

        const text = response.content.trim();
        if (text.startsWith('CONNECTION:')) {
          const connection = text.slice('CONNECTION:'.length).trim();
          results.push({
            pageA: pathA,
            titleA: pageA.title,
            pageB: pathB,
            titleB: pageB.title,
            connection,
          });
        }
      } catch { /* skip this pair */ }
    }
  } catch { /* LLM unavailable — return empty */ }

  return results;
}

// ─── Cross-Link Discovery ────────────────────────────────────────────────────

export interface CrossLinkOpportunity {
  pageA: string;
  titleA: string;
  pageB: string;
  titleB: string;
  reason: string;
  confidence: number; // 0-1
}

/**
 * Find pages that discuss the same concepts but don't link to each other.
 * Uses keyword overlap, tag similarity, and entity co-occurrence.
 */
function crossLinkDiscovery(pagePaths: string[]): CrossLinkOpportunity[] {
  const opportunities: CrossLinkOpportunity[] = [];

  interface PageData {
    path: string;
    slug: string;
    title: string;
    tags: Set<string>;
    keywords: Set<string>;
    linkedSlugs: Set<string>;
  }

  const titleToSlug = new Map<string, string>();
  const pageDataList: PageData[] = [];

  // First pass: build lookup table
  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const slug = basename(p, '.md');
      titleToSlug.set(page.title.toLowerCase(), slug);
      titleToSlug.set(slug, slug);
    } catch { /* skip */ }
  }

  // Second pass: collect page data
  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const slug = basename(p, '.md');
      const tags = new Set(
        (Array.isArray(page.frontmatter['tags']) ? (page.frontmatter['tags'] as string[]) : [])
          .map(t => t.toLowerCase().trim())
          .filter(Boolean),
      );

      // Extract significant words (>4 chars, not common stop words)
      const stopWords = new Set(['about', 'after', 'again', 'being', 'between', 'could', 'different', 'does', 'during', 'every', 'first', 'found', 'great', 'however', 'including', 'known', 'large', 'might', 'never', 'other', 'should', 'since', 'small', 'something', 'still', 'their', 'these', 'thing', 'think', 'those', 'through', 'under', 'using', 'very', 'which', 'while', 'would', 'years']);
      const words = page.content.toLowerCase().split(/\W+/).filter(w => w.length > 4 && !stopWords.has(w));
      const wordFreq = new Map<string, number>();
      for (const w of words) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
      // Keep top keywords by frequency
      const sortedWords = [...wordFreq.entries()].sort((a, b) => b[1] - a[1]);
      const keywords = new Set(sortedWords.slice(0, 30).map(([w]) => w));

      // Resolve which slugs this page already links to
      const linkedSlugs = new Set<string>();
      for (const link of page.wikilinks) {
        const target = titleToSlug.get(link.toLowerCase())
          ?? titleToSlug.get(link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        if (target) linkedSlugs.add(target);
      }

      pageDataList.push({ path: p, slug, title: page.title, tags, keywords, linkedSlugs });
    } catch { /* skip */ }
  }

  // Compare pairs for keyword/tag overlap
  const limit = Math.min(pageDataList.length, 150); // cap O(n^2) at manageable size
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const a = pageDataList[i]!;
      const b = pageDataList[j]!;

      // Skip if already linked in either direction
      if (a.linkedSlugs.has(b.slug) || b.linkedSlugs.has(a.slug)) continue;

      // Tag overlap
      const sharedTags = [...a.tags].filter(t => b.tags.has(t));
      // Keyword overlap
      const sharedKeywords = [...a.keywords].filter(k => b.keywords.has(k));

      // Score the opportunity
      const tagScore = Math.min(sharedTags.length / 2, 1); // 2+ shared tags = max
      const keywordScore = Math.min(sharedKeywords.length / 8, 1); // 8+ shared keywords = max
      const confidence = tagScore * 0.4 + keywordScore * 0.6;

      if (confidence >= 0.4) {
        const reasons: string[] = [];
        if (sharedTags.length > 0) reasons.push(`${sharedTags.length} shared tags: ${sharedTags.slice(0, 3).join(', ')}`);
        if (sharedKeywords.length > 0) reasons.push(`${sharedKeywords.length} shared keywords`);

        opportunities.push({
          pageA: a.path,
          titleA: a.title,
          pageB: b.path,
          titleB: b.title,
          reason: reasons.join('; '),
          confidence: Math.round(confidence * 100) / 100,
        });
      }
    }
    if (opportunities.length >= 50) break;
  }

  return opportunities
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 30);
}

// ─── Experiment Log ──────────────────────────────────────────────────────────

export interface ExperimentEntry {
  id: string;
  date: string;
  action: string;
  target: string;
  hypothesis: string;
  result: 'success' | 'failure' | 'neutral';
  scoreBefore?: number;
  scoreAfter?: number;
  details: string;
}

export interface ExperimentLog {
  entries: ExperimentEntry[];
  /** Patterns the observer has learned from past experiments */
  learnedPatterns: string[];
}

function getExperimentLogPath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'observer-experiment-log.json');
}

function loadExperimentLog(vaultRoot: string): ExperimentLog {
  const logPath = getExperimentLogPath(vaultRoot);
  if (!existsSync(logPath)) return { entries: [], learnedPatterns: [] };
  try {
    return JSON.parse(readFileSync(logPath, 'utf-8')) as ExperimentLog;
  } catch {
    return { entries: [], learnedPatterns: [] };
  }
}

function saveExperimentLog(vaultRoot: string, log: ExperimentLog): void {
  const dir = join(vaultRoot, '.wikimem');
  mkdirSync(dir, { recursive: true });
  writeFileSync(getExperimentLogPath(vaultRoot), JSON.stringify(log, null, 2), 'utf-8');
}

function appendExperiment(
  vaultRoot: string,
  entry: Omit<ExperimentEntry, 'id' | 'date'>,
): void {
  const log = loadExperimentLog(vaultRoot);
  log.entries.push({
    id: `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    date: new Date().toISOString(),
    ...entry,
  });

  // Auto-learn patterns from experiment history (every 10 entries)
  if (log.entries.length % 10 === 0) {
    const successes = log.entries.filter(e => e.result === 'success');
    const failures = log.entries.filter(e => e.result === 'failure');

    // Extract which actions tend to succeed
    const actionSuccess = new Map<string, number>();
    const actionTotal = new Map<string, number>();
    for (const e of log.entries) {
      actionTotal.set(e.action, (actionTotal.get(e.action) ?? 0) + 1);
      if (e.result === 'success') {
        actionSuccess.set(e.action, (actionSuccess.get(e.action) ?? 0) + 1);
      }
    }

    const newPatterns: string[] = [];
    for (const [action, total] of actionTotal) {
      const success = actionSuccess.get(action) ?? 0;
      const rate = total > 0 ? success / total : 0;
      if (total >= 3 && rate >= 0.7) {
        newPatterns.push(`Action "${action}" has ${Math.round(rate * 100)}% success rate (${success}/${total}) — prioritize`);
      } else if (total >= 3 && rate <= 0.3) {
        newPatterns.push(`Action "${action}" has ${Math.round(rate * 100)}% success rate (${success}/${total}) — deprioritize or rethink approach`);
      }
    }

    if (successes.length > 0 || failures.length > 0) {
      newPatterns.push(`Overall success rate: ${Math.round((successes.length / log.entries.length) * 100)}% across ${log.entries.length} experiments`);
    }

    if (newPatterns.length > 0) {
      log.learnedPatterns = newPatterns;
    }
  }

  // Keep experiment log at a reasonable size (last 200 entries)
  if (log.entries.length > 200) {
    log.entries = log.entries.slice(-200);
  }

  saveExperimentLog(vaultRoot, log);
}

// ─── Budget Estimation ───────────────────────────────────────────────────────

export interface BudgetEstimate {
  estimatedCostUsd: number;
  pagesEligible: number;
  pagesAfterCap: number;
  budgetRemaining: number;
  capped: boolean;
}

function estimateBudget(
  scores: PageScore[],
  options: ObserverOptions,
): BudgetEstimate {
  const maxBudget = options.maxBudget ?? 2.0;
  const maxImprovements = options.maxImprovements ?? 3;
  const costPerPage = COST_PER_IMPROVEMENT_ESTIMATE;

  const eligible = scores.filter(s => s.score < s.maxScore * 0.5 && s.issues.length > 0);
  const budgetAllowedPages = Math.floor(maxBudget / costPerPage);
  const effectiveMax = Math.min(maxImprovements, budgetAllowedPages, eligible.length);
  const estimatedCost = effectiveMax * costPerPage;

  return {
    estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
    pagesEligible: eligible.length,
    pagesAfterCap: effectiveMax,
    budgetRemaining: Math.round((maxBudget - estimatedCost) * 100) / 100,
    capped: eligible.length > effectiveMax,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────────

export interface ObserverOptions {
  maxPagesToReview?: number;
  /** Max budget per run in USD (default: $2.00). Limits how many pages can be auto-improved. */
  maxBudget?: number;
  /** When true, use LLM to improve the weakest pages (not just score them) */
  autoImprove?: boolean;
  /** Max pages to auto-improve per run (default: 3) */
  maxImprovements?: number;
  /** Model to use for observer LLM calls (overrides config default) */
  model?: string;
}

const COST_PER_IMPROVEMENT_ESTIMATE = 0.15;

// ─── LLM-Powered Improvement ──────────────────────────────────────────────────

export interface ImprovementResult {
  page: string;
  title: string;
  originalScore: number;
  newScore?: number;
  action: string;
  improved: boolean;
  error?: string;
}

const IMPROVE_SYSTEM_PROMPT = `You are a wiki quality improvement agent. You are given a wiki page that has quality issues.

Your job is to improve the page by:
1. Adding a meaningful summary to the frontmatter if missing
2. Adding relevant tags if missing
3. Improving structure with proper headings if readability is low
4. Expanding very short pages with useful context
5. Adding [[wikilinks]] to related concepts if the page has no outbound links
6. Adding source citations or references where possible
7. Improving cross-referencing with contextual wikilinks in prose (not just "See also")

Rules:
- Preserve all existing content — only ADD, never remove
- Keep the existing YAML frontmatter format
- Use [[Double Bracket]] notation for wikilinks
- Be concise but informative
- Return the COMPLETE page content including frontmatter`;

async function improveWeakPages(
  config: VaultConfig,
  scores: PageScore[],
  options: ObserverOptions,
  incomingLinks: Map<string, number>,
): Promise<ImprovementResult[]> {
  const results: ImprovementResult[] = [];
  const maxToImprove = options.maxImprovements ?? 3;
  const maxBudget = options.maxBudget ?? 2.0;
  const budgetAllowedPages = Math.floor(maxBudget / COST_PER_IMPROVEMENT_ESTIMATE);
  const effectiveMax = Math.min(maxToImprove, budgetAllowedPages);

  if (effectiveMax <= 0) return results;

  // Use experiment log to inform page selection
  const experimentLog = loadExperimentLog(config.root);
  const recentFailedPages = new Set(
    experimentLog.entries
      .filter(e => e.result === 'failure' && e.action === 'improve-page')
      .slice(-20)
      .map(e => e.target),
  );

  const weakPages = scores
    .filter((s) => s.score < s.maxScore * 0.5 && s.issues.length > 0)
    // Deprioritize pages that recently failed improvement
    .filter((s) => !recentFailedPages.has(s.page))
    .sort((a, b) => a.score - b.score)
    .slice(0, effectiveMax);

  if (weakPages.length === 0) return results;

  const { loadConfig } = await import('./config.js');
  const userConfig = loadConfig(config.configPath);

  for (const weak of weakPages) {
    try {
      const fullContent = readFileSync(weak.page, 'utf-8');
      const issueList = weak.issues.map((i) => `- ${i}`).join('\n');

      const prompt = `Improve this wiki page. Current quality score: ${weak.score}/${weak.maxScore}

Issues found:
${issueList}

Current page content:
---
${fullContent}
---

Return the improved complete page content.`;

      let improved: string;

      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const provider = createProviderFromUserConfig(userConfig);
      const response = await provider.chat([
        { role: 'user', content: prompt },
      ], { systemPrompt: IMPROVE_SYSTEM_PROMPT, maxTokens: 4096 });
      improved = response.content;

      if (improved && improved.trim().length > fullContent.length * 0.5) {
        writeFileSync(weak.page, improved.trim(), 'utf-8');
        // Re-score to get newScore
        const reScored = scorePage(weak.page, incomingLinks);
        const success = reScored.score > weak.score;

        results.push({
          page: weak.page,
          title: weak.title,
          originalScore: weak.score,
          newScore: reScored.score,
          action: `Improved: ${weak.issues.slice(0, 3).join(', ')}`,
          improved: true,
        });

        // Log experiment
        appendExperiment(config.root, {
          action: 'improve-page',
          target: weak.page,
          hypothesis: `Improving issues [${weak.issues.slice(0, 2).join(', ')}] should raise score from ${weak.score}`,
          result: success ? 'success' : 'neutral',
          scoreBefore: weak.score,
          scoreAfter: reScored.score,
          details: success
            ? `Score improved ${weak.score} → ${reScored.score} (+${reScored.score - weak.score})`
            : `Score unchanged at ${reScored.score} despite improvement attempt`,
        });
      } else {
        results.push({
          page: weak.page,
          title: weak.title,
          originalScore: weak.score,
          action: 'LLM response too short — skipped',
          improved: false,
        });

        appendExperiment(config.root, {
          action: 'improve-page',
          target: weak.page,
          hypothesis: `LLM would produce usable improvement for score ${weak.score} page`,
          result: 'failure',
          scoreBefore: weak.score,
          details: 'LLM response was too short to be useful',
        });
      }
    } catch (err) {
      results.push({
        page: weak.page,
        title: weak.title,
        originalScore: weak.score,
        action: 'Error during improvement',
        improved: false,
        error: err instanceof Error ? err.message : String(err),
      });

      appendExperiment(config.root, {
        action: 'improve-page',
        target: weak.page,
        hypothesis: `Improvement would succeed for page with score ${weak.score}`,
        result: 'failure',
        scoreBefore: weak.score,
        details: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return results;
}

export interface ObserverReport {
  date: string;
  generatedAt: string;
  totalPages: number;
  pagesReviewed: number;
  averageScore: number;
  maxScore: number;
  scores: PageScore[];
  orphans: OrphanPage[];
  contradictions: PotentialContradiction[];
  gaps: KnowledgeGap[];
  topIssues: Array<{ issue: string; count: number }>;
  improvements: ImprovementResult[];
  /** Open-ended discoveries — patterns the observer found that weren't explicitly searched for */
  unexpectedPatterns: UnexpectedPattern[];
  /** Suggested new pages based on coverage analysis */
  pageSuggestions: PageSuggestion[];
  /** Cross-link opportunities — pages that should link to each other */
  crossLinks: CrossLinkOpportunity[];
  /** Budget consumed and remaining */
  budget: BudgetEstimate;
  /** Insights from past experiments */
  experimentInsights: string[];
  // ── New open-endedness fields (Jeff Clune P0-C) ──
  /** Repeated themes across 3+ pages — candidates for new concept pages */
  vaultPatterns: VaultPattern[];
  /** LLM-detected semantic contradictions between related pages */
  semanticContradictions: SemanticContradiction[];
  /** Top 5 wikilink targets with no existing page */
  missingPageSuggestions: MissingPageSuggestion[];
  /** Pages not updated in 30+ days, ranked by staleness urgency */
  stalePages: StalePage[];
  /** Serendipitous non-obvious connections between pages from different categories */
  serendipitousConnections: SerendipitousConnection[];
}

export function getObserverReportsDir(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'observer-reports');
}

export async function runObserver(config: VaultConfig, options?: ObserverOptions): Promise<ObserverReport> {
  const startMs = Date.now();
  const allPaths = listWikiPages(config.wikiDir);
  const incomingLinks = buildIncomingLinksMap(allPaths);

  const reviewPaths = options?.maxPagesToReview
    ? allPaths.slice(0, options.maxPagesToReview)
    : allPaths;

  const scores = reviewPaths.map((p) => scorePage(p, incomingLinks));
  const orphans = findOrphans(allPaths, incomingLinks);
  const contradictions = flagContradictions(reviewPaths);
  const gaps = findGaps(allPaths);

  // Open-ended discovery — find things we didn't know to look for
  const unexpectedPatterns = discoverUnexpected(allPaths, incomingLinks);
  const pageSuggestions = suggestNewPages(allPaths, gaps);
  const crossLinks = crossLinkDiscovery(allPaths);

  // ── P0-C: Jeff Clune open-endedness extensions ──
  // Build existing-titles set (shared across multiple new functions)
  const existingTitlesSet = new Set<string>();
  for (const p of allPaths) {
    try {
      const page = readWikiPage(p);
      existingTitlesSet.add(page.title.toLowerCase());
      existingTitlesSet.add(basename(p, '.md').toLowerCase());
    } catch { /* skip */ }
  }

  // 1. Pattern detection: themes appearing in 3+ pages → suggest concept page
  const vaultPatterns = detectVaultPatterns(allPaths, existingTitlesSet);

  // 2. Semantic contradiction detection (LLM, budget-gated — max 8 pairs)
  const semanticContradictions = await detectSemanticContradictions(reviewPaths, options ?? {}, 8);

  // 3. Knowledge-gap suggestions: top 5 most-referenced missing wikilinks
  const missingPageSuggestions = suggestMissingPages(allPaths, gaps);

  // 4. Temporal staleness scan: pages stale 30+ days, ranked by urgency
  const stalePages = scanTemporalStaleness(allPaths, incomingLinks, 30);

  // 5. Serendipitous connections: random cross-category pairs via LLM (max 3)
  const serendipitousConnections = await findSerendipitousConnections(allPaths, options ?? {}, 3);

  const avgScore =
    scores.length > 0
      ? Math.round((scores.reduce((s, p) => s + p.score, 0) / scores.length) * 10) / 10
      : 0;

  // Tally most common issues
  const issueCounts = new Map<string, number>();
  for (const s of scores) {
    for (const issue of s.issues) {
      issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
    }
  }
  const topIssues = Array.from(issueCounts.entries())
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Budget estimation before running improvements
  const budget = estimateBudget(scores, options ?? {});

  // LLM-powered improvement of weakest pages
  let improvements: ImprovementResult[] = [];
  if (options?.autoImprove) {
    improvements = await improveWeakPages(config, scores, options, incomingLinks);
  }

  // Log discovery experiments
  if (unexpectedPatterns.length > 0) {
    appendExperiment(config.root, {
      action: 'discover-patterns',
      target: 'wiki-wide',
      hypothesis: 'Open-ended scan will find unknown-unknowns in wiki structure',
      result: 'success',
      details: `Found ${unexpectedPatterns.length} unexpected patterns: ${unexpectedPatterns.map(p => p.type).join(', ')}`,
    });
  }

  if (crossLinks.length > 0) {
    appendExperiment(config.root, {
      action: 'discover-crosslinks',
      target: 'wiki-wide',
      hypothesis: 'Cross-link analysis will find pages that should be connected',
      result: crossLinks.length > 0 ? 'success' : 'neutral',
      details: `Found ${crossLinks.length} cross-link opportunities (avg confidence: ${crossLinks.length > 0 ? Math.round(crossLinks.reduce((sum, c) => sum + c.confidence, 0) / crossLinks.length * 100) : 0}%)`,
    });
  }

  // Log P0-C experiments
  if (vaultPatterns.length > 0) {
    appendExperiment(config.root, {
      action: 'detect-vault-patterns',
      target: 'wiki-wide',
      hypothesis: 'Heading-keyword frequency will surface emerging concept pages',
      result: 'success',
      details: `Found ${vaultPatterns.length} repeated themes: top topics — ${vaultPatterns.slice(0, 3).map(p => p.topic).join(', ')}`,
    });
  }

  if (semanticContradictions.length > 0) {
    appendExperiment(config.root, {
      action: 'semantic-contradiction-detection',
      target: 'wiki-wide',
      hypothesis: 'LLM can detect semantic contradictions beyond keyword heuristics',
      result: 'success',
      details: `Found ${semanticContradictions.length} semantic contradictions via LLM`,
    });
  }

  if (stalePages.length > 0) {
    appendExperiment(config.root, {
      action: 'temporal-staleness-scan',
      target: 'wiki-wide',
      hypothesis: 'Temporal scan will identify high-impact stale content',
      result: 'success',
      details: `Found ${stalePages.length} stale pages (30+ days). Top: "${stalePages[0]?.title}" (${stalePages[0]?.daysSinceUpdate} days, score ${stalePages[0]?.stalenessScore})`,
    });
  }

  if (serendipitousConnections.length > 0) {
    appendExperiment(config.root, {
      action: 'serendipitous-connection',
      target: 'wiki-wide',
      hypothesis: 'LLM can find non-obvious connections between unrelated wiki pages',
      result: 'success',
      details: `Found ${serendipitousConnections.length} serendipitous connections: ${serendipitousConnections.map(c => `"${c.titleA}" ↔ "${c.titleB}"`).join('; ')}`,
    });
  }

  // Load experiment insights to include in report
  const experimentLog = loadExperimentLog(config.root);
  const experimentInsights = experimentLog.learnedPatterns;

  const date = new Date().toISOString().split('T')[0] ?? '';
  const report: ObserverReport = {
    date,
    generatedAt: new Date().toISOString(),
    totalPages: allPaths.length,
    pagesReviewed: reviewPaths.length,
    averageScore: avgScore,
    maxScore: MAX_SCORE,
    scores: scores.sort((a, b) => a.score - b.score),
    orphans,
    contradictions,
    gaps,
    topIssues,
    improvements,
    unexpectedPatterns,
    pageSuggestions,
    crossLinks,
    budget,
    experimentInsights,
    vaultPatterns,
    semanticContradictions,
    missingPageSuggestions,
    stalePages,
    serendipitousConnections,
  };

  // Save report
  const reportsDir = getObserverReportsDir(config.root);
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${date}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Build rich commit body with details
  const improvementLines = improvements
    .filter((i) => i.improved)
    .map((i) => `  + ${i.title} (was ${i.originalScore}/${MAX_SCORE}): ${i.action}`);
  const failedLines = improvements
    .filter((i) => !i.improved)
    .map((i) => `  x ${i.title}: ${i.action}${i.error ? ` — ${i.error}` : ''}`);

  const weakestPages = scores
    .filter((s) => s.score < MAX_SCORE * 0.7)
    .slice(0, 5)
    .map((s) => `  ${s.title}: ${s.score}/${MAX_SCORE} — ${s.issues[0] ?? 'no issues'}`);

  const discoveryLines = unexpectedPatterns
    .filter(p => p.significance !== 'low')
    .slice(0, 5)
    .map(p => `  [${p.significance}] ${p.description}`);

  const commitBodyParts = [
    `Pages: ${allPaths.length} (reviewed: ${reviewPaths.length})`,
    `Average score: ${avgScore}/${MAX_SCORE}`,
    `Orphans: ${orphans.length} | Gaps: ${gaps.length} | Contradictions: ${contradictions.length}`,
    `Cross-link opportunities: ${crossLinks.length} | Page suggestions: ${pageSuggestions.length}`,
    `Unexpected patterns: ${unexpectedPatterns.length}`,
    `Vault patterns: ${vaultPatterns.length} | Stale pages: ${stalePages.length} | Semantic contradictions: ${semanticContradictions.length} | Serendipitous: ${serendipitousConnections.length}`,
  ];
  if (budget.capped) {
    commitBodyParts.push(`Budget: $${budget.estimatedCostUsd} of $${budget.estimatedCostUsd + budget.budgetRemaining} (${budget.pagesEligible} eligible, ${budget.pagesAfterCap} improved)`);
  }
  if (improvementLines.length > 0) {
    commitBodyParts.push('', 'Improvements applied:', ...improvementLines);
  }
  if (failedLines.length > 0) {
    commitBodyParts.push('', 'Improvement failures:', ...failedLines);
  }
  if (discoveryLines.length > 0) {
    commitBodyParts.push('', 'Discoveries:', ...discoveryLines);
  }
  if (weakestPages.length > 0) {
    commitBodyParts.push('', 'Weakest pages:', ...weakestPages);
  }
  if (experimentInsights.length > 0) {
    commitBodyParts.push('', 'Learned patterns:', ...experimentInsights.map(p => `  - ${p}`));
  }
  const commitBody = commitBodyParts.join('\n');

  const commitSubject = improvements.some((i) => i.improved)
    ? `quality scan + ${improvements.filter((i) => i.improved).length} page(s) improved`
    : 'nightly quality scan';

  // Auto-commit
  try {
    const { autoCommit, isGitRepo } = await import('./git.js');
    let commitHash: string | undefined;
    if (await isGitRepo(config.root)) {
      const commitResult = await autoCommit(
        config.root,
        'observe',
        commitSubject,
        commitBody,
      );
      commitHash = commitResult?.hash;
    }

    const improveSummary = improvements.length > 0
      ? ` Improved ${improvements.filter((i) => i.improved).length}/${improvements.length} pages.`
      : '';

    const discoverySummary = unexpectedPatterns.length > 0
      ? ` ${unexpectedPatterns.length} patterns discovered.`
      : '';

    appendAuditEntry(config.root, {
      action: 'observe',
      actor: 'observer',
      source: reportPath,
      summary: `Quality scan: ${allPaths.length} pages (${reviewPaths.length} reviewed), avg score ${avgScore}/${MAX_SCORE}, ${orphans.length} orphans, ${gaps.length} gaps, ${contradictions.length} contradictions, ${crossLinks.length} cross-link opportunities.${improveSummary}${discoverySummary}`,
      pagesAffected: [
        ...improvements.filter((i) => i.improved).map((i) => basename(i.page, '.md')),
        ...reviewPaths.map((p) => basename(p, '.md')),
      ],
      commitHash,
      duration: Date.now() - startMs,
    });
  } catch {
    // git/audit failure is non-fatal
  }

  // Record history snapshot for time-lapse
  try {
    const { recordSnapshot } = await import('./history.js');
    recordSnapshot(config, 'improve', `Observer scan: ${allPaths.length} pages, avg score ${avgScore}/${MAX_SCORE}, ${unexpectedPatterns.length} discoveries`);
  } catch {
    // History recording is optional
  }

  return report;
}

// ─── Report Listing ───────────────────────────────────────────────────────────

export function listObserverReports(vaultRoot: string): string[] {
  const dir = getObserverReportsDir(vaultRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
}

export function readObserverReport(vaultRoot: string, date: string): ObserverReport | null {
  const dir = getObserverReportsDir(vaultRoot);
  const reportPath = join(dir, `${date}.json`);
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf-8')) as ObserverReport;
  } catch {
    return null;
  }
}

/** Read the experiment log for UI display or debugging */
export function readExperimentLog(vaultRoot: string): ExperimentLog {
  return loadExperimentLog(vaultRoot);
}

// ─── Cron Scheduler ──────────────────────────────────────────────────────────

let scheduledJob: ReturnType<typeof cron.schedule> | null = null;

export function startObserverCron(config: VaultConfig): void {
  if (scheduledJob) return; // already running

  // Run at 3:00 AM every night
  scheduledJob = cron.schedule('0 3 * * *', async () => {
    console.log('[observer] Starting nightly quality scan...');
    try {
      const report = await runObserver(config);
      console.log(
        `[observer] Done — ${report.totalPages} pages (${report.pagesReviewed} reviewed), avg score ${report.averageScore}/${report.maxScore}, ${report.orphans.length} orphans, ${report.unexpectedPatterns.length} discoveries.`,
      );
    } catch (err) {
      console.error('[observer] Nightly scan failed:', err);
    }
  });

  console.log('  Observer cron scheduled: nightly at 3:00 AM');
}

export function stopObserverCron(): void {
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
  }
}

export function isObserverCronRunning(): boolean {
  return scheduledJob !== null;
}
