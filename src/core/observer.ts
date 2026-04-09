/**
 * Automation 2: Observer (Self-Improvement Engine)
 *
 * Runs nightly at 3am (or on demand) to score every wiki page for quality,
 * find orphans, flag contradictions, and identify knowledge gaps.
 *
 * Reports saved to .wikimem/observer-reports/YYYY-MM-DD.json
 * Auto-committed as: wiki: observe: nightly quality scan
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import cron from 'node-cron';
import { listWikiPages, readWikiPage } from './vault.js';
import type { VaultConfig } from './vault.js';
import { appendAuditEntry } from './audit-trail.js';

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface PageScore {
  page: string;
  title: string;
  score: number;
  breakdown: {
    hasSummary: boolean;
    hasLinksOut: boolean;
    hasLinksIn: boolean;
    wordCount: number;
    hasTags: boolean;
  };
  issues: string[];
}

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

  // 0-10 scoring: each criterion worth up to 2 points
  let score = 0;
  if (hasSummary) score += 2;
  if (hasLinksOut) score += 2;
  if (hasLinksIn) score += 2;
  if (page.wordCount >= 50) score += 2;
  else if (page.wordCount >= 20) score += 1;
  if (hasTags) score += 2;

  if (!hasSummary) issues.push('Missing or empty summary in frontmatter');
  if (!hasLinksOut) issues.push('No outbound [[wikilinks]] — isolated page');
  if (!hasLinksIn) issues.push('No pages link to this page (orphan candidate)');
  if (page.wordCount < 50) issues.push(`Very short content (${page.wordCount} words)`);
  if (!hasTags) issues.push('No tags defined');

  return {
    page: pagePath,
    title: page.title,
    score,
    breakdown: {
      hasSummary,
      hasLinksOut,
      hasLinksIn,
      wordCount: page.wordCount,
      hasTags,
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
function flagContradictions(pagePaths: string[]): PotentialContradiction[] {
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

// ─── Report ───────────────────────────────────────────────────────────────────

export interface ObserverReport {
  date: string;
  generatedAt: string;
  totalPages: number;
  averageScore: number;
  scores: PageScore[];
  orphans: OrphanPage[];
  contradictions: PotentialContradiction[];
  gaps: KnowledgeGap[];
  topIssues: Array<{ issue: string; count: number }>;
}

export function getObserverReportsDir(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'observer-reports');
}

export async function runObserver(config: VaultConfig): Promise<ObserverReport> {
  const startMs = Date.now();
  const pagePaths = listWikiPages(config.wikiDir);
  const incomingLinks = buildIncomingLinksMap(pagePaths);

  const scores = pagePaths.map((p) => scorePage(p, incomingLinks));
  const orphans = findOrphans(pagePaths, incomingLinks);
  const contradictions = flagContradictions(pagePaths);
  const gaps = findGaps(pagePaths);

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

  const date = new Date().toISOString().split('T')[0] ?? '';
  const report: ObserverReport = {
    date,
    generatedAt: new Date().toISOString(),
    totalPages: pagePaths.length,
    averageScore: avgScore,
    scores: scores.sort((a, b) => a.score - b.score), // worst first
    orphans,
    contradictions,
    gaps,
    topIssues,
  };

  // Save report
  const reportsDir = getObserverReportsDir(config.root);
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${date}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Auto-commit
  try {
    const { autoCommit, isGitRepo } = await import('./git.js');
    let commitHash: string | undefined;
    if (await isGitRepo(config.root)) {
      const commitResult = await autoCommit(
        config.root,
        'observe',
        'nightly quality scan',
        `Pages: ${pagePaths.length} | Avg score: ${avgScore}/10 | Orphans: ${orphans.length} | Gaps: ${gaps.length}`,
      );
      commitHash = commitResult?.hash;
    }

    appendAuditEntry(config.root, {
      action: 'observe',
      actor: 'observer',
      source: reportPath,
      summary: `Nightly quality scan: ${pagePaths.length} pages, avg score ${avgScore}/10, ${orphans.length} orphans, ${gaps.length} gaps, ${contradictions.length} contradictions.`,
      pagesAffected: pagePaths.map((p) => basename(p, '.md')),
      commitHash,
      duration: Date.now() - startMs,
    });
  } catch {
    // git/audit failure is non-fatal
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
        `[observer] Done — ${report.totalPages} pages, avg score ${report.averageScore}/10, ${report.orphans.length} orphans.`,
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
