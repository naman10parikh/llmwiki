/**
 * Extended MCP tool handlers for WikiMem.
 *
 * Handles: wikimem_observe, wikimem_improve, wikimem_pipeline,
 *          wikimem_scrape, wikimem_connectors
 *
 * All imports are dynamic to keep MCP server startup fast.
 */

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VaultConfig } from './core/vault.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── wikimem_observe ──────────────────────────────────────────────────────

export async function handleObserve(
  config: VaultConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const pageArg = typeof args['page'] === 'string' ? args['page'].trim() : null;
  const { runObserver } = await import('./core/observer.js');

  const report = await runObserver(config, { maxPagesToReview: pageArg ? 1 : undefined });

  if (pageArg) {
    const target = pageArg.toLowerCase();
    const match = report.scores.find(
      (s) => s.title.toLowerCase() === target
        || basename(s.page, '.md').toLowerCase() === target,
    );
    if (!match) {
      return {
        found: false,
        message: `No page found matching "${pageArg}". Use wikimem_list to see available pages.`,
      };
    }
    return {
      found: true,
      page: match.title,
      score: match.score,
      maxScore: match.maxScore,
      breakdown: match.breakdown,
      issues: match.issues,
    };
  }

  const weakPages = report.scores
    .filter((s) => s.score < s.maxScore * 0.5)
    .slice(0, 20)
    .map((s) => ({ title: s.title, score: s.score, maxScore: s.maxScore, issues: s.issues }));

  return {
    date: report.date,
    totalPages: report.totalPages,
    pagesReviewed: report.pagesReviewed,
    averageScore: report.averageScore,
    maxScore: report.maxScore,
    weakPages,
    orphanCount: report.orphans.length,
    orphans: report.orphans.slice(0, 15).map((o) => o.title),
    gapCount: report.gaps.length,
    gaps: report.gaps.slice(0, 10),
    contradictions: report.contradictions.slice(0, 10),
    topIssues: report.topIssues,
  };
}

// ─── wikimem_improve ──────────────────────────────────────────────────────

export async function handleImprove(
  config: VaultConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const pageArg = typeof args['page'] === 'string' ? args['page'].trim() : null;
  const autoApply = args['autoApply'] === true;

  const { loadConfig } = await import('./core/config.js');
  const userConfig = loadConfig(config.configPath);

  const { createProviderFromUserConfig } = await import('./providers/index.js');
  const provider = createProviderFromUserConfig(userConfig);

  const { improveWiki } = await import('./core/improve.js');
  const result = await improveWiki(config, provider, {
    threshold: 80,
    dryRun: !autoApply,
  });

  let actions = result.actions;
  if (pageArg) {
    const target = pageArg.toLowerCase();
    actions = actions.filter(
      (a) => a.description.toLowerCase().includes(target),
    );
  }

  return {
    score: result.score,
    dimensions: result.dimensions,
    actionCount: actions.length,
    actions: actions.map((a) => ({
      type: a.type,
      description: a.description,
      applied: a.applied,
    })),
    autoApply,
    message: autoApply
      ? `Applied ${actions.filter((a) => a.applied).length}/${actions.length} improvements.`
      : `Found ${actions.length} improvement(s). Set autoApply=true to apply them.`,
  };
}

// ─── wikimem_pipeline ─────────────────────────────────────────────────────

export async function handlePipeline(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;

  const { pipelineEvents } = await import('./core/pipeline-events.js');
  pipelineEvents.initPersistence(vaultRoot);

  const recentRuns = pipelineEvents.getRecentRuns().slice(0, limit);
  const currentRun = pipelineEvents.getCurrentRun();

  const { getConnectorManager } = await import('./core/connectors.js');
  const cm = getConnectorManager(vaultRoot);
  const connectors = cm.getAll();

  return {
    currentRun: currentRun
      ? {
          id: currentRun.id,
          source: currentRun.source,
          startedAt: currentRun.startedAt,
          stepCount: currentRun.events.length,
          lastStep: currentRun.events[currentRun.events.length - 1] ?? null,
        }
      : null,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      source: r.source,
      startedAt: r.startedAt,
      status: r.events[r.events.length - 1]?.step ?? 'unknown',
      pagesCreated: r.result?.pagesCreated ?? 0,
      linksAdded: r.result?.linksAdded ?? 0,
      title: r.result?.title ?? '',
    })),
    connectorHealth: connectors.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      lastSyncAt: c.lastSyncAt ?? null,
      totalFiles: c.totalFiles ?? 0,
      errorMessage: c.errorMessage ?? null,
    })),
    totalRuns: recentRuns.length,
  };
}

// ─── wikimem_scrape ───────────────────────────────────────────────────────

export async function handleScrape(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = args['url'];
  if (typeof url !== 'string' || !url.trim()) {
    throw { code: -32602, message: 'url must be a non-empty string' };
  }

  const { spawn } = await import('node:child_process');
  const wikimemBin = join(__dirname, 'index.js');

  const cliArgs = [wikimemBin, 'ingest', url, '--vault', vaultRoot];

  const tags = args['tags'];
  if (Array.isArray(tags) && tags.length > 0) {
    cliArgs.push('--tags', tags.join(','));
  }

  const result = await new Promise<{ success: boolean; output: string }>((res) => {
    const proc = spawn(
      process.execPath,
      cliArgs,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code) => res({ success: code === 0, output }));
    proc.on('error', (err) => res({ success: false, output: err.message }));
  });

  return {
    url,
    tags: Array.isArray(tags) ? tags : [],
    success: result.success,
    output: result.output.trim(),
    message: result.success
      ? `Successfully scraped and ingested: ${url}`
      : `Scrape/ingest failed. See output for details.`,
  };
}

// ─── wikimem_connectors ───────────────────────────────────────────────────

export async function handleConnectors(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = args['action'];
  if (typeof action !== 'string') {
    throw { code: -32602, message: 'action is required (list | add | remove | sync)' };
  }

  const { getConnectorManager } = await import('./core/connectors.js');
  const cm = getConnectorManager(vaultRoot);

  switch (action) {
    case 'list': {
      const connectors = cm.getAll();
      return {
        count: connectors.length,
        connectors: connectors.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          path: c.path,
          url: c.url ?? null,
          status: c.status,
          autoSync: c.autoSync ?? false,
          lastSyncAt: c.lastSyncAt ?? null,
          totalFiles: c.totalFiles ?? 0,
          createdAt: c.createdAt,
        })),
      };
    }

    case 'add': {
      const connName = args['name'];
      const connType = args['type'];
      const connPath = args['path'];
      if (typeof connName !== 'string' || !connName.trim()) {
        throw { code: -32602, message: 'name is required for add action' };
      }
      if (connType !== 'folder' && connType !== 'git-repo') {
        throw { code: -32602, message: 'type must be "folder" or "git-repo"' };
      }
      if (typeof connPath !== 'string' || !connPath.trim()) {
        throw { code: -32602, message: 'path is required for add action' };
      }

      const connector = cm.add({
        name: connName.trim(),
        type: connType,
        path: connPath.trim(),
        url: typeof args['url'] === 'string' ? args['url'] : undefined,
        autoSync: args['autoSync'] === true,
        includeGlobs: Array.isArray(args['includeGlobs']) ? args['includeGlobs'] as string[] : undefined,
      });

      return {
        success: true,
        connector: {
          id: connector.id,
          name: connector.name,
          type: connector.type,
          path: connector.path,
          status: connector.status,
          autoSync: connector.autoSync ?? false,
        },
        message: `Connector "${connector.name}" added with ID ${connector.id}.`,
      };
    }

    case 'remove': {
      const removeId = args['id'];
      if (typeof removeId !== 'string' || !removeId.trim()) {
        throw { code: -32602, message: 'id is required for remove action' };
      }
      const removed = cm.remove(removeId.trim());
      return {
        success: removed,
        message: removed
          ? `Connector ${removeId} removed.`
          : `No connector found with ID ${removeId}.`,
      };
    }

    case 'sync': {
      const syncId = args['id'];
      if (typeof syncId !== 'string' || !syncId.trim()) {
        throw { code: -32602, message: 'id is required for sync action' };
      }
      const connector = cm.get(syncId.trim());
      if (!connector) {
        return {
          success: false,
          message: `No connector found with ID ${syncId}.`,
        };
      }

      cm.updateStatus(connector.id, 'syncing');

      try {
        const files = await cm.scanFiles(connector);
        cm.updateStatus(connector.id, 'active', {
          lastSyncAt: new Date().toISOString(),
          totalFiles: files.length,
        });

        return {
          success: true,
          connectorId: connector.id,
          connectorName: connector.name,
          filesFound: files.length,
          message: `Sync complete for "${connector.name}": found ${files.length} ingestible files.`,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        cm.updateStatus(connector.id, 'error', { errorMessage: errMsg });
        return {
          success: false,
          connectorId: connector.id,
          error: errMsg,
          message: `Sync failed for "${connector.name}": ${errMsg}`,
        };
      }
    }

    default:
      throw { code: -32602, message: `Unknown connector action: ${action}. Use list, add, remove, or sync.` };
  }
}
