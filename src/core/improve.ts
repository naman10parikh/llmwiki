import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage, writeWikiPage, getVaultStats, extractWikilinks } from './vault.js';
import { lintWiki } from './lint.js';
import { appendLog } from './log-manager.js';

export interface ImproveAction {
  type: 'reorganize' | 'cross-link' | 'flag-contradiction' | 'suggest-page' | 'cleanup';
  description: string;
  applied: boolean;
}

export interface ImproveResult {
  score: number;
  dimensions: Record<string, number>;
  actions: ImproveAction[];
}

interface ImproveOptions {
  threshold: number;
  dryRun: boolean;
}

export async function improveWiki(
  config: VaultConfig,
  provider: LLMProvider,
  options: ImproveOptions,
): Promise<ImproveResult> {
  // Phase 1: Score — evaluate wiki quality across dimensions
  const stats = getVaultStats(config);
  const lintResult = await lintWiki(config, provider, { fix: false });

  const pages = listWikiPages(config.wikiDir);
  const pageCount = pages.length;

  // Calculate dimension scores
  const dimensions: Record<string, number> = {
    coverage: calculateCoverage(config, pageCount),
    consistency: Math.max(0, 100 - lintResult.issues.filter((i) => i.category === 'contradiction').length * 15),
    crossLinking: calculateCrossLinking(stats, pageCount),
    freshness: calculateFreshness(config, pages),
    organization: calculateOrganization(lintResult.issues),
  };

  const score = Math.round(
    Object.values(dimensions).reduce((sum, s) => sum + s, 0) / Object.keys(dimensions).length,
  );

  // Phase 2: Decide — if score >= threshold, no action needed
  if (score >= options.threshold) {
    appendLog(config.logPath, `improve | score ${score}/100`, `Above threshold (${options.threshold}). No changes needed.`);
    return { score, dimensions, actions: [] };
  }

  // Phase 3: Improve — use LLM Council to propose improvements
  const actions = await proposeImprovements(config, provider, lintResult, dimensions);

  // Phase 4: Apply (unless dry-run)
  if (!options.dryRun) {
    for (const action of actions) {
      try {
        await applyAction(action, config, provider);
        action.applied = true;
      } catch {
        // Non-fatal: log but continue with remaining actions
        action.applied = false;
      }
    }
  }

  appendLog(
    config.logPath,
    `improve | score ${score}/100`,
    `${actions.length} improvement(s) ${options.dryRun ? 'proposed' : 'applied'}. Dimensions: ${JSON.stringify(dimensions)}`,
  );

  if (!options.dryRun && actions.length > 0) {
    try {
      const { autoCommit } = await import('./git.js');
      await autoCommit(
        config.root,
        'improve',
        `${actions.length} improvements applied (score ${score}/100)`,
        `Dimensions: ${JSON.stringify(dimensions)}`,
      );
    } catch {
      // Git commit failure is non-fatal
    }
  }

  return { score, dimensions, actions };
}

function calculateCoverage(config: VaultConfig, pageCount: number): number {
  const stats = getVaultStats(config);
  if (stats.sourceCount === 0) return 0;
  // Rough heuristic: each source should produce ~3 pages
  const expectedPages = stats.sourceCount * 3;
  return Math.min(100, Math.round((pageCount / expectedPages) * 100));
}

function calculateCrossLinking(stats: VaultStats, pageCount: number): number {
  if (pageCount <= 1) return 100;
  // Target: at least 2 links per page
  const targetLinks = pageCount * 2;
  return Math.min(100, Math.round((stats.wikilinks / targetLinks) * 100));
}

function calculateOrganization(issues: Array<{ category: string }>): number {
  const orgIssues = issues.filter((i) =>
    i.category === 'orphan' || i.category === 'no-summary' || i.category === 'empty',
  ).length;
  return Math.max(0, 100 - orgIssues * 8);
}

async function proposeImprovements(
  config: VaultConfig,
  provider: LLMProvider,
  lintResult: { issues: Array<{ category: string; message: string; page?: string }> },
  dimensions: Record<string, number>,
): Promise<ImproveAction[]> {
  const actions: ImproveAction[] = [];

  // Generate actions from lint issues
  for (const issue of lintResult.issues.slice(0, 10)) {
    switch (issue.category) {
      case 'orphan':
        actions.push({
          type: 'cross-link',
          description: `Add inbound links to orphan page: ${issue.page ?? 'unknown'}`,
          applied: false,
        });
        break;
      case 'missing-link':
        actions.push({
          type: 'suggest-page',
          description: `Create missing page referenced by broken wikilink: ${issue.message}`,
          applied: false,
        });
        break;
      case 'no-summary':
        actions.push({
          type: 'cleanup',
          description: `Add frontmatter summary to: ${issue.page ?? 'unknown'}`,
          applied: false,
        });
        break;
      case 'empty':
        actions.push({
          type: 'cleanup',
          description: `Expand or remove near-empty page: ${issue.page ?? 'unknown'}`,
          applied: false,
        });
        break;
    }
  }

  // If cross-linking score is low, suggest connections
  if ((dimensions['crossLinking'] ?? 0) < 60) {
    actions.push({
      type: 'cross-link',
      description: 'Wiki has few cross-references. Consider adding [[wikilinks]] between related pages.',
      applied: false,
    });
  }

  return actions;
}

function calculateFreshness(config: VaultConfig, pages: string[]): number {
  if (pages.length === 0) return 100;

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  let totalScore = 0;

  for (const pagePath of pages) {
    try {
      const stat = statSync(pagePath);
      const ageMs = now - stat.mtimeMs;
      // Pages updated within 30 days get 100, linearly decaying to 0 at 180 days
      const pageScore = Math.max(0, Math.min(100, Math.round(100 - (ageMs / (thirtyDaysMs * 6)) * 100)));
      totalScore += pageScore;
    } catch {
      totalScore += 50; // Default for unreadable files
    }
  }

  return Math.round(totalScore / pages.length);
}

async function applyAction(
  action: ImproveAction,
  config: VaultConfig,
  provider: LLMProvider,
): Promise<void> {
  switch (action.type) {
    case 'cross-link': {
      const orphanMatch = action.description.match(/orphan page: (.+)$/);
      if (orphanMatch?.[1]) {
        const orphanPath = orphanMatch[1];
        // Resolve page title from file — never write raw file paths as wikilinks
        let linkTitle: string;
        if (existsSync(orphanPath)) {
          try {
            const page = readWikiPage(orphanPath);
            linkTitle = page.title;
          } catch {
            linkTitle = basename(orphanPath, extname(orphanPath));
          }
        } else {
          linkTitle = basename(orphanPath, extname(orphanPath));
        }
        if (existsSync(config.indexPath)) {
          const indexContent = readFileSync(config.indexPath, 'utf-8');
          if (!indexContent.includes(`[[${linkTitle}]]`)) {
            const updatedIndex = indexContent + `\n- [[${linkTitle}]]\n`;
            writeFileSync(config.indexPath, updatedIndex, 'utf-8');
          }
        }
      }
      break;
    }
    case 'cleanup': {
      const pageMatch = action.description.match(/to: (.+)$/);
      if (pageMatch?.[1]) {
        const targetPath = pageMatch[1];
        // If the description contains a file path, apply directly
        if (existsSync(targetPath)) {
          try {
            const page = readWikiPage(targetPath);
            if (!page.frontmatter['summary']) {
              const firstSentence = page.content.split(/[.!?]\s/)[0] ?? '';
              page.frontmatter['summary'] = firstSentence.substring(0, 120);
              writeWikiPage(targetPath, page.content, page.frontmatter);
            }
          } catch {
            // Skip unreadable pages
          }
        } else {
          // Fallback: match by title across all pages
          const pages = listWikiPages(config.wikiDir);
          for (const pagePath of pages) {
            try {
              const page = readWikiPage(pagePath);
              if (page.title === targetPath && !page.frontmatter['summary']) {
                const firstSentence = page.content.split(/[.!?]\s/)[0] ?? '';
                page.frontmatter['summary'] = firstSentence.substring(0, 120);
                writeWikiPage(pagePath, page.content, page.frontmatter);
              }
            } catch {
              // Skip unreadable pages
            }
          }
        }
      }
      break;
    }
    case 'suggest-page': {
      const linkMatch = action.description.match(/broken wikilink: (.+)$/);
      if (!linkMatch?.[1]) break;
      const missingTitle = linkMatch[1].replace(/\[\[|\]\]/g, '');
      const slug = missingTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const targetPath = join(config.wikiDir, 'concepts', `${slug}.md`);
      if (existsSync(targetPath)) break;

      // Gather context from pages that reference this missing link
      const pages = listWikiPages(config.wikiDir);
      const contextSnippets: string[] = [];
      for (const p of pages) {
        try {
          const page = readWikiPage(p);
          if (page.content.includes(`[[${missingTitle}]]`)) {
            const lines = page.content.split('\n');
            for (const line of lines) {
              if (line.includes(`[[${missingTitle}]]`)) {
                contextSnippets.push(`From "${page.title}": ${line.trim()}`);
              }
            }
          }
        } catch { /* skip */ }
      }

      const resp = await provider.chat([
        { role: 'system', content: 'You are a wiki editor. Generate a concise wiki page (100-300 words) based on context from pages that reference this topic. Use markdown. Include a one-sentence summary. Do not include frontmatter.' },
        { role: 'user', content: `Create a wiki page for "${missingTitle}".\n\nContext from linking pages:\n${contextSnippets.slice(0, 8).join('\n')}` },
      ], { maxTokens: 600, temperature: 0.3 });

      const today = new Date().toISOString().split('T')[0];
      const summary = resp.content.split(/[.!?]\s/)[0]?.substring(0, 120) ?? '';
      const fm: Record<string, unknown> = {
        title: missingTitle,
        type: 'concept',
        created: today,
        updated: today,
        tags: [],
        sources: [],
        related: [],
        summary,
      };
      writeWikiPage(targetPath, `\n# ${missingTitle}\n\n${resp.content}\n`, fm);
      break;
    }
    case 'reorganize': {
      // Identify near-duplicate or closely related pages and suggest merges
      const pages = listWikiPages(config.wikiDir);
      const pageSummaries: string[] = [];
      for (const p of pages.slice(0, 40)) {
        try {
          const page = readWikiPage(p);
          const summary = (page.frontmatter['summary'] as string) || page.content.substring(0, 80);
          pageSummaries.push(`- ${page.title}: ${summary}`);
        } catch { /* skip */ }
      }

      const resp = await provider.chat([
        { role: 'system', content: 'You are a wiki organizer. Analyze the page list and suggest 1-3 concrete reorganization actions. For each, output exactly: ACTION: merge|split|rename, PAGES: page1, page2, REASON: why. Keep it brief.' },
        { role: 'user', content: `Wiki pages:\n${pageSummaries.join('\n')}` },
      ], { maxTokens: 400, temperature: 0.2 });

      // Update the action description with the LLM's suggestions
      action.description += ` — LLM suggestions: ${resp.content.substring(0, 300)}`;
      // Reorganize actions are advisory — they update the description but don't auto-apply file changes
      break;
    }
    case 'flag-contradiction': {
      // Find pages that discuss the same topic and check for conflicting claims
      const pages = listWikiPages(config.wikiDir);
      const pageContents: Array<{ title: string; excerpt: string; path: string }> = [];
      for (const p of pages.slice(0, 30)) {
        try {
          const page = readWikiPage(p);
          pageContents.push({
            title: page.title,
            excerpt: page.content.substring(0, 400),
            path: p,
          });
        } catch { /* skip */ }
      }

      // Group by shared wikilinks to find topically related pages
      const linkMap = new Map<string, string[]>();
      for (const p of pageContents) {
        const links = extractWikilinks(p.excerpt);
        for (const link of links) {
          if (!linkMap.has(link)) linkMap.set(link, []);
          linkMap.get(link)!.push(p.title);
        }
      }
      const overlapping = [...linkMap.entries()]
        .filter(([, titles]) => titles.length >= 2)
        .slice(0, 5);

      if (overlapping.length === 0) break;

      const pairsText = overlapping.map(([topic, titles]) =>
        `Topic "[[${topic}]]" discussed in: ${titles.join(', ')}`
      ).join('\n');

      const excerptText = pageContents
        .filter(p => overlapping.some(([, titles]) => titles.includes(p.title)))
        .map(p => `## ${p.title}\n${p.excerpt}`)
        .join('\n\n');

      const resp = await provider.chat([
        { role: 'system', content: 'You are a fact-checker for a wiki. Given overlapping pages, identify any contradictions or inconsistencies between them. For each contradiction found, output: CONFLICT: page1 vs page2 — description. If no contradictions, say "No contradictions found."' },
        { role: 'user', content: `Pages with shared topics:\n${pairsText}\n\nExcerpts:\n${excerptText}` },
      ], { maxTokens: 500, temperature: 0.1 });

      action.description += ` — ${resp.content.substring(0, 300)}`;
      break;
    }
  }
}

// Re-export for type use
import type { VaultStats } from './vault.js';
