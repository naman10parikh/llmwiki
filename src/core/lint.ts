import { existsSync } from 'node:fs';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage, getVaultStats } from './vault.js';
import { basename } from 'node:path';

export interface LintIssue {
  category: 'orphan' | 'contradiction' | 'stale' | 'missing-link' | 'empty' | 'no-summary';
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
    return { score: 0, issues: [{ category: 'empty', severity: 'error', message: 'Wiki has no pages. Run `llmwiki ingest` to add content.' }] };
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
  for (const page of pageData) {
    if (page.title === 'index' || page.title === 'log') continue;
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
    if (!page.frontmatter['summary'] && page.title !== 'index' && page.title !== 'log') {
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

  // Calculate score
  const maxIssues = pageData.length * 3; // rough estimate
  const issueWeight = issues.reduce((sum, i) => sum + (i.severity === 'error' ? 10 : 3), 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - (issueWeight / Math.max(maxIssues, 1)) * 100)));

  return { score, issues };
}
