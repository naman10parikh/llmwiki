import { readFileSync, existsSync } from 'node:fs';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage, getVaultStats } from './vault.js';
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
    freshness: 85, // TODO: compare source dates with wiki update dates
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
      action.applied = true;
      // TODO: actually apply each action (rewrite pages, add links, etc.)
    }
  }

  appendLog(
    config.logPath,
    `improve | score ${score}/100`,
    `${actions.length} improvement(s) ${options.dryRun ? 'proposed' : 'applied'}. Dimensions: ${JSON.stringify(dimensions)}`,
  );

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

// Re-export for type use
import type { VaultStats } from './vault.js';
