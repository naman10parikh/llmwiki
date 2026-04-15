import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage } from './vault.js';
import { basename } from 'node:path';
import { flagContradictions } from './observer.js';

export interface LintIssue {
  category: 'orphan' | 'contradiction' | 'stale' | 'missing-link' | 'empty' | 'no-summary' | 'no-tldr' | 'duplicate-title' | 'malformed-frontmatter';
  severity: 'error' | 'warning';
  message: string;
  page?: string;
  fixed?: boolean;
}

export interface LintResult {
  score: number;
  issues: LintIssue[];
}

interface LintOptions {
  fix: boolean;
}

export async function lintWiki(
  config: VaultConfig,
  _provider: LLMProvider,
  _options: LintOptions,
): Promise<LintResult> {
  const issues: LintIssue[] = [];
  const pages = listWikiPages(config.wikiDir);

  if (pages.length === 0) {
    return { score: 0, issues: [{ category: 'empty', severity: 'error', message: 'Wiki has no pages. Run `wikimem ingest` to add content.' }] };
  }

  // Collect all page titles and wikilinks
  const allTitles = new Set<string>();
  const allLinkedTo = new Set<string>();
  const pageData: Array<{ path: string; title: string; wikilinks: string[]; wordCount: number; frontmatter: Record<string, unknown> }> = [];

  for (const pagePath of pages) {
    try {
      const page = readWikiPage(pagePath);
      allTitles.add(page.title);
      for (const link of page.wikilinks) {
        allLinkedTo.add(link);
      }
      pageData.push({
        path: pagePath,
        title: page.title,
        wikilinks: page.wikilinks,
        wordCount: page.wordCount,
        frontmatter: page.frontmatter,
      });
    } catch {
      issues.push({
        category: 'empty',
        severity: 'error',
        message: `Failed to read page: ${pagePath}`,
        page: pagePath,
      });
    }
  }

  // Check 1: Orphan pages (no inbound links)
  const structuralPages = new Set(['index', 'log', 'Wiki Index', 'Wiki Log']);
  for (const page of pageData) {
    if (structuralPages.has(page.title) || page.path.endsWith('/index.md') || page.path.endsWith('/log.md')) continue;
    if (!allLinkedTo.has(page.title)) {
      issues.push({
        category: 'orphan',
        severity: 'warning',
        message: `Orphan page: "${page.title}" has no inbound links`,
        page: page.path,
      });
    }
  }

  // Check 2: Broken wikilinks (link to non-existent page)
  for (const page of pageData) {
    for (const link of page.wikilinks) {
      if (!allTitles.has(link)) {
        issues.push({
          category: 'missing-link',
          severity: 'warning',
          message: `Broken wikilink: "${page.title}" links to non-existent "[[${link}]]"`,
          page: page.path,
        });
      }
    }
  }

  // Check 3: Pages without summary in frontmatter
  for (const page of pageData) {
    if (!page.frontmatter['summary'] && !structuralPages.has(page.title) && !page.path.endsWith('/index.md') && !page.path.endsWith('/log.md')) {
      issues.push({
        category: 'no-summary',
        severity: 'warning',
        message: `Page "${page.title}" missing frontmatter summary`,
        page: page.path,
      });
    }
  }

  // Check 4: Empty pages (< 10 words)
  for (const page of pageData) {
    if (page.wordCount < 10 && page.title !== 'index' && page.title !== 'log') {
      issues.push({
        category: 'empty',
        severity: 'warning',
        message: `Page "${page.title}" is nearly empty (${page.wordCount} words)`,
        page: page.path,
      });
    }
  }

  // Check 5: Potential contradictions (same heuristic as Observer)
  for (const c of flagContradictions(pages)) {
    issues.push({
      category: 'contradiction',
      severity: 'warning',
      message: c.reason,
      page: c.pageA,
    });
  }

  // Check 6 (KARP-002): Pages missing TLDR field in frontmatter
  for (const page of pageData) {
    if (
      structuralPages.has(page.title) ||
      page.path.endsWith('/index.md') ||
      page.path.endsWith('/log.md')
    ) continue;
    const hasTldr = page.frontmatter['tldr'] &&
      String(page.frontmatter['tldr']).trim().length > 0;
    if (!hasTldr) {
      issues.push({
        category: 'no-tldr',
        severity: 'warning',
        message: `Page "${page.title}" is missing a tldr frontmatter field (run \`wikimem improve\` to auto-generate)`,
        page: page.path,
      });
    }
  }

  // Check 7 (KARP-005): Duplicate page titles
  const titleCount = new Map<string, string[]>();
  for (const page of pageData) {
    const norm = page.title.toLowerCase().trim();
    if (!titleCount.has(norm)) titleCount.set(norm, []);
    titleCount.get(norm)!.push(page.path);
  }
  for (const [title, paths] of titleCount) {
    if (paths.length > 1) {
      issues.push({
        category: 'duplicate-title',
        severity: 'error',
        message: `Duplicate title "${title}" found across ${paths.length} pages: ${paths.map(p => basename(p)).join(', ')}`,
        page: paths[0],
      });
    }
  }

  // Check 8 (KARP-005): Malformed frontmatter — missing required fields
  const requiredFields = ['title', 'type'];
  for (const page of pageData) {
    if (page.path.endsWith('/index.md') || page.path.endsWith('/log.md')) continue;
    const missing = requiredFields.filter(f => !page.frontmatter[f]);
    if (missing.length > 0) {
      issues.push({
        category: 'malformed-frontmatter',
        severity: 'warning',
        message: `Page "${page.title}" (${basename(page.path)}) is missing frontmatter field(s): ${missing.join(', ')}`,
        page: page.path,
      });
    }
  }

  // Calculate score — weight by severity and category
  // Broken wikilinks are common in growing wikis (knowledge gaps), so weight them low
  const issueWeight = issues.reduce((sum, i) => {
    if (i.severity === 'error') return sum + 10;
    if (i.category === 'missing-link') return sum + 0.5; // knowledge gaps are normal
    if (i.category === 'no-summary') return sum + 1;
    if (i.category === 'no-tldr') return sum + 0.5; // informational, not blocking
    return sum + 2;
  }, 0);
  const maxPenalty = pageData.length * 5; // rough ceiling
  const score = Math.max(0, Math.min(100, Math.round(100 - (issueWeight / Math.max(maxPenalty, 1)) * 100)));

  return { score, issues };
}
