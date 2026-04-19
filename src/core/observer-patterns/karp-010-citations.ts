/**
 * KARP-010 — Citation scoring
 *
 * For every page with outbound URLs, score each citation:
 *   - Source quality: domain rank (.edu > .gov > known high-trust > news > other)
 *   - Specificity: URL depth, presence of anchor hash, title match
 *   - Recency: year in URL or frontmatter date
 *
 * Per-page citationScore (0-100) written to frontmatter. Aggregate average
 * returned in result. Budget: 0 LLM calls.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import matter from 'gray-matter';
import { readWikiPage } from '../vault.js';

export interface CitationScoreDetail {
  url: string;
  score: number;
  domainTier: number;
  specificity: number;
  recency: number;
  linkText: string;
}

export interface PageCitationScore {
  page: string;
  title: string;
  citationCount: number;
  citationScore: number; // 0-100 average across URLs
  worstCite: CitationScoreDetail | null;
}

export interface CitationsResult {
  pagesScored: number;
  totalCitations: number;
  avgCitationScore: number;
  pagesUpdated: number;
  durationMs: number;
  worstFive: Array<{ page: string; title: string; detail: CitationScoreDetail }>;
}

/** Known high-quality domains, mapped to tier (100=best, 40=news, 20=unknown). */
const DOMAIN_TIER: Record<string, number> = {
  // Academic / standards
  'arxiv.org': 95,
  'acm.org': 95,
  'ieee.org': 95,
  'nature.com': 95,
  'science.org': 95,
  'plos.org': 90,
  'pubmed.ncbi.nlm.nih.gov': 95,
  'ncbi.nlm.nih.gov': 92,
  'jstor.org': 90,
  'springer.com': 88,
  'sciencedirect.com': 88,
  'w3.org': 92,
  'rfc-editor.org': 92,
  'ietf.org': 92,
  // Well-known code / docs
  'github.com': 85,
  'gitlab.com': 80,
  'wikipedia.org': 88,
  'wikimedia.org': 85,
  'mdn.mozilla.org': 92,
  'developer.mozilla.org': 92,
  'docs.python.org': 90,
  'nodejs.org': 90,
  'typescriptlang.org': 88,
  'kernel.org': 90,
  // AI labs
  'anthropic.com': 80,
  'openai.com': 78,
  'deepmind.com': 82,
  'research.google': 82,
  'ai.meta.com': 78,
  'huggingface.co': 75,
  // News / tech trade press
  'nytimes.com': 65,
  'wsj.com': 65,
  'ft.com': 65,
  'bbc.com': 65,
  'bbc.co.uk': 65,
  'theguardian.com': 60,
  'reuters.com': 70,
  'apnews.com': 70,
  'bloomberg.com': 68,
  'economist.com': 68,
  'npr.org': 60,
  'techcrunch.com': 50,
  'theverge.com': 50,
  'wired.com': 55,
  'arstechnica.com': 60,
  'news.ycombinator.com': 55,
  'reddit.com': 35,
  'medium.com': 40,
  'substack.com': 40,
  'twitter.com': 25,
  'x.com': 25,
  'youtube.com': 40,
  'stackexchange.com': 70,
  'stackoverflow.com': 70,
};

/** Extract URLs from markdown body + any URLs from frontmatter.sources. */
function extractUrls(body: string, frontmatter: Record<string, unknown>): Array<{ url: string; linkText: string }> {
  const out: Array<{ url: string; linkText: string }> = [];
  const seen = new Set<string>();
  // Markdown link: [text](url)
  const mdLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLink.exec(body)) !== null) {
    const url = (m[2] ?? '').trim();
    const text = (m[1] ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, linkText: text });
  }
  // Bare URLs
  const bareUrl = /(?<![("[])(https?:\/\/[^\s)\]]+)/g;
  while ((m = bareUrl.exec(body)) !== null) {
    const url = (m[1] ?? '').replace(/[.,;:]+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, linkText: '' });
  }
  // Frontmatter sources
  const src = frontmatter['sources'];
  if (Array.isArray(src)) {
    for (const s of src) {
      if (typeof s === 'string' && /^https?:\/\//.test(s) && !seen.has(s)) {
        seen.add(s);
        out.push({ url: s, linkText: '' });
      }
    }
  }
  return out;
}

/** Rank a domain. Returns 0-100. */
function rankDomain(urlStr: string): number {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (DOMAIN_TIER[host] !== undefined) return DOMAIN_TIER[host] ?? 50;
    // Exact entry missed — try the registrable part (e.g. "sub.nytimes.com" -> "nytimes.com")
    const parts = host.split('.');
    if (parts.length >= 2) {
      const parent = parts.slice(-2).join('.');
      if (DOMAIN_TIER[parent] !== undefined) return DOMAIN_TIER[parent] ?? 50;
    }
    if (host.endsWith('.edu')) return 90;
    if (host.endsWith('.gov')) return 90;
    if (host.endsWith('.org') || host.endsWith('.ac.uk')) return 70;
    return 35;
  } catch {
    return 20;
  }
}

/** Specificity score 0-100: path depth, hash anchor, query params. */
function specificity(urlStr: string): number {
  try {
    const u = new URL(urlStr);
    const segments = u.pathname.split('/').filter(Boolean);
    let s = 0;
    s += Math.min(segments.length * 15, 60); // depth
    if (u.hash && u.hash.length > 1) s += 20; // anchor target
    if (u.search && u.search.length > 1) s += 10; // query params = deep-link
    // Fully-qualified filename at the end (.pdf, .html, etc.) = highly specific
    const last = segments[segments.length - 1] ?? '';
    if (/\.(pdf|html?|md|txt)$/i.test(last)) s += 10;
    return Math.min(s, 100);
  } catch {
    return 0;
  }
}

/** Recency score 0-100 based on year in URL, frontmatter, or undated. */
function recency(urlStr: string, frontmatter: Record<string, unknown>): number {
  const currentYear = new Date().getUTCFullYear();
  // Try URL first
  const yearMatch = urlStr.match(/\/(20\d{2})\b/);
  if (yearMatch?.[1]) {
    const year = parseInt(yearMatch[1], 10);
    return yearToScore(year, currentYear);
  }
  // Try frontmatter.updated / created
  const candidates = ['updated', 'created', 'published', 'date'];
  for (const key of candidates) {
    const v = frontmatter[key];
    if (typeof v === 'string') {
      const yr = v.match(/(20\d{2})/)?.[1];
      if (yr) return yearToScore(parseInt(yr, 10), currentYear);
    }
  }
  // No date evidence — neutral 50
  return 50;
}

function yearToScore(year: number, current: number): number {
  const diff = current - year;
  if (diff <= 0) return 100;
  if (diff <= 1) return 90;
  if (diff <= 2) return 80;
  if (diff <= 4) return 65;
  if (diff <= 7) return 45;
  if (diff <= 10) return 30;
  return 15;
}

/** Compute title-match bonus (0-15). */
function titleMatchBonus(urlStr: string, linkText: string): number {
  if (!linkText) return 0;
  const slug = linkText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return 0;
  try {
    const u = new URL(urlStr);
    const pathLower = u.pathname.toLowerCase();
    if (pathLower.includes(slug)) return 15;
    // Partial word match
    const tokens = slug.split('-').filter((t) => t.length > 3);
    let hits = 0;
    for (const t of tokens) if (pathLower.includes(t)) hits++;
    return Math.min(hits * 4, 12);
  } catch {
    return 0;
  }
}

function scoreOne(
  url: string,
  linkText: string,
  frontmatter: Record<string, unknown>,
): CitationScoreDetail {
  const domainTier = rankDomain(url);
  const spec = specificity(url);
  const rec = recency(url, frontmatter);
  const bonus = titleMatchBonus(url, linkText);
  // Weighted composite — domain is dominant signal
  const raw = domainTier * 0.55 + spec * 0.2 + rec * 0.2 + bonus;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { url, score, domainTier, specificity: spec, recency: rec, linkText };
}

function writeScoreToPage(pagePath: string, score: number): void {
  const raw = readFileSync(pagePath, 'utf-8');
  const { data, content } = matter(raw);
  data['citationScore'] = score;
  writeFileSync(pagePath, matter.stringify(content, data), 'utf-8');
}

export interface Karp010Options {
  dryRun?: boolean;
}

export async function runKarp010(
  pagePaths: string[],
  options: Karp010Options = {},
): Promise<CitationsResult> {
  const started = Date.now();
  process.stderr.write(`[KARP-010] scoring citations across ${pagePaths.length} pages...\n`);

  const pageScores: PageCitationScore[] = [];
  let totalCites = 0;
  let totalScore = 0;
  let pagesUpdated = 0;
  const allWorst: Array<{ page: string; title: string; detail: CitationScoreDetail }> = [];

  for (const p of pagePaths) {
    try {
      const page = readWikiPage(p);
      const urls = extractUrls(page.content, page.frontmatter);
      if (urls.length === 0) continue;

      const details = urls.map(({ url, linkText }) =>
        scoreOne(url, linkText, page.frontmatter),
      );
      const avg = Math.round(
        details.reduce((sum, d) => sum + d.score, 0) / details.length,
      );
      const worst = details.slice().sort((a, b) => a.score - b.score)[0] ?? null;

      pageScores.push({
        page: p,
        title: page.title,
        citationCount: urls.length,
        citationScore: avg,
        worstCite: worst,
      });
      totalCites += urls.length;
      totalScore += avg;

      if (worst) {
        allWorst.push({ page: p, title: page.title, detail: worst });
      }

      if (!options.dryRun && page.frontmatter['citationScore'] !== avg) {
        writeScoreToPage(p, avg);
        pagesUpdated++;
      }
    } catch {
      /* skip */
    }
  }

  const avgCitationScore = pageScores.length > 0
    ? Math.round((totalScore / pageScores.length) * 10) / 10
    : 0;

  const worstFive = allWorst
    .sort((a, b) => a.detail.score - b.detail.score)
    .slice(0, 5);

  process.stderr.write(
    `[KARP-010] scored ${totalCites} citations across ${pageScores.length} pages; avg ${avgCitationScore}/100\n`,
  );

  return {
    pagesScored: pageScores.length,
    totalCitations: totalCites,
    avgCitationScore,
    pagesUpdated,
    durationMs: Date.now() - started,
    worstFive,
  };
}
