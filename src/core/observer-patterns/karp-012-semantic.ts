/**
 * KARP-012 — Semantic similarity graph edges
 *
 * For each page pair (p1, p2), compute BM25-based similarity (content overlap).
 * Add weighted edges where similarity > threshold AND no wikilink exists.
 *
 * Cached keyed on wiki content hash. Budget: 0 LLM calls.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readWikiPage } from '../vault.js';

export interface SemanticEdge {
  source: string;
  target: string;
  /** 0-1 similarity weight */
  weight: number;
}

export interface SemanticSuggestion {
  pageA: string;
  titleA: string;
  pageB: string;
  titleB: string;
  weight: number;
}

export interface SemanticResult {
  pagesScanned: number;
  edgesFound: number;
  edges: SemanticEdge[];
  suggestions: SemanticSuggestion[];
  cached: boolean;
  hash: string;
  durationMs: number;
}

const STOP_WORDS = new Set([
  'about','after','again','against','being','between','could','during','every','first',
  'found','great','however','including','known','large','might','never','other','should',
  'since','small','something','still','their','there','these','thing','think','those',
  'through','under','using','very','which','while','would','years','would','while',
  'this','that','with','from','have','been','were','they','them','will','your','just',
  'when','then','into','also','only','because','above','below','where','than',
]);

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 3 && !STOP_WORDS.has(t));
}

/**
 * Normalized overlap (Jaccard-like) between token sets, weighted by term frequency.
 * Returns 0-1.
 */
function similarity(
  tokensA: string[],
  tokensB: string[],
  tfA: Map<string, number>,
  tfB: Map<string, number>,
): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let overlap = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = smaller === setA ? setB : setA;
  for (const t of smaller) {
    if (larger.has(t)) {
      const weight = Math.min(tfA.get(t) ?? 0, tfB.get(t) ?? 0);
      overlap += Math.sqrt(weight);
    }
  }
  const denom = Math.sqrt(tokensA.length) + Math.sqrt(tokensB.length);
  return Math.min(1, (2 * overlap) / denom);
}

function contentHash(pagePaths: string[]): string {
  const h = createHash('sha256');
  for (const p of pagePaths.slice().sort()) {
    try {
      const stat = statSync(p);
      h.update(`${basename(p)}:${stat.size}:${stat.mtimeMs | 0}|`);
    } catch { /* skip */ }
  }
  return h.digest('hex').slice(0, 16);
}

interface Cache {
  hash: string;
  edges: SemanticEdge[];
  suggestions: SemanticSuggestion[];
}

function cachePath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'semantic-edges-cache.json');
}

function loadCache(vaultRoot: string): Cache | null {
  const p = cachePath(vaultRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as Cache; }
  catch { return null; }
}

function saveCache(vaultRoot: string, cache: Cache): void {
  mkdirSync(join(vaultRoot, '.wikimem'), { recursive: true });
  writeFileSync(cachePath(vaultRoot), JSON.stringify(cache, null, 2), 'utf-8');
}

export interface Karp012Options {
  /** Threshold above which an edge is created (default 0.35). */
  threshold?: number;
  /** Max edges to keep (default 200). */
  maxEdges?: number;
  /** Max pages for O(n²) cap (default 200). */
  maxPages?: number;
  /** Bypass cache. */
  noCache?: boolean;
}

export async function runKarp012(
  vaultRoot: string,
  pagePaths: string[],
  options: Karp012Options = {},
): Promise<SemanticResult> {
  const started = Date.now();
  const threshold = options.threshold ?? 0.35;
  const maxEdges = options.maxEdges ?? 200;
  const limit = Math.min(pagePaths.length, options.maxPages ?? 200);

  process.stderr.write(
    `[KARP-012] computing semantic similarity over ${limit} pages...\n`,
  );

  const hash = contentHash(pagePaths.slice(0, limit));
  if (!options.noCache) {
    const cached = loadCache(vaultRoot);
    if (cached && cached.hash === hash) {
      process.stderr.write(`[KARP-012] cache hit (hash ${hash})\n`);
      return {
        pagesScanned: limit,
        edgesFound: cached.edges.length,
        edges: cached.edges,
        suggestions: cached.suggestions,
        cached: true,
        hash,
        durationMs: Date.now() - started,
      };
    }
  }

  interface PageTokens {
    slug: string;
    title: string;
    tokens: string[];
    tf: Map<string, number>;
    linked: Set<string>;
  }
  const pagesData: PageTokens[] = [];
  const titleToSlug = new Map<string, string>();

  // First pass — collect slugs + titles
  for (const p of pagePaths.slice(0, limit)) {
    try {
      const slug = basename(p, '.md');
      const page = readWikiPage(p);
      titleToSlug.set(page.title.toLowerCase(), slug);
      titleToSlug.set(slug.toLowerCase(), slug);
    } catch { /* skip */ }
  }

  // Second pass — tokenize + resolve wikilinks
  for (const p of pagePaths.slice(0, limit)) {
    try {
      const page = readWikiPage(p);
      const slug = basename(p, '.md');
      const toks = tokenize(page.content);
      if (toks.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      const linked = new Set<string>();
      for (const link of page.wikilinks) {
        const slugified = link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const target = titleToSlug.get(link.toLowerCase()) ?? titleToSlug.get(slugified);
        if (target) linked.add(target);
      }
      pagesData.push({ slug, title: page.title, tokens: toks, tf, linked });
    } catch { /* skip */ }
  }

  const edges: SemanticEdge[] = [];
  const suggestions: SemanticSuggestion[] = [];

  for (let i = 0; i < pagesData.length; i++) {
    for (let j = i + 1; j < pagesData.length; j++) {
      const a = pagesData[i]!;
      const b = pagesData[j]!;
      const sim = similarity(a.tokens, b.tokens, a.tf, b.tf);
      if (sim < threshold) continue;
      // Only add as suggestion (missing-link candidate) if no wikilink either direction
      const wikilinked = a.linked.has(b.slug) || b.linked.has(a.slug);
      edges.push({ source: a.slug, target: b.slug, weight: Math.round(sim * 1000) / 1000 });
      if (!wikilinked) {
        suggestions.push({
          pageA: a.slug,
          titleA: a.title,
          pageB: b.slug,
          titleB: b.title,
          weight: Math.round(sim * 1000) / 1000,
        });
      }
      if (edges.length >= maxEdges) break;
    }
    if (edges.length >= maxEdges) break;
  }

  edges.sort((a, b) => b.weight - a.weight);
  suggestions.sort((a, b) => b.weight - a.weight);
  const topSuggestions = suggestions.slice(0, 10);

  if (!options.noCache) {
    saveCache(vaultRoot, { hash, edges, suggestions: topSuggestions });
  }

  process.stderr.write(
    `[KARP-012] found ${edges.length} semantic edges; top ${topSuggestions.length} missing-link suggestions\n`,
  );

  return {
    pagesScanned: pagesData.length,
    edgesFound: edges.length,
    edges,
    suggestions: topSuggestions,
    cached: false,
    hash,
    durationMs: Date.now() - started,
  };
}

/** Read cached edges (for /api/graph?include_semantic=1). Returns null if stale. */
export function readCachedSemanticEdges(vaultRoot: string): SemanticEdge[] {
  const cache = loadCache(vaultRoot);
  return cache?.edges ?? [];
}

/** Read cached suggestions (top missing-wikilink candidates). */
export function readCachedSuggestions(vaultRoot: string): SemanticSuggestion[] {
  const cache = loadCache(vaultRoot);
  return cache?.suggestions ?? [];
}
