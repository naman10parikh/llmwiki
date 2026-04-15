/**
 * Extended MCP tool handlers for WikiMem.
 *
 * Handles: wikimem_observe, wikimem_improve, wikimem_pipeline,
 *          wikimem_scrape, wikimem_connectors,
 *          wikimem_list_connectors, wikimem_connect, wikimem_sync,
 *          wikimem_preview, wikimem_run_observer, wikimem_get_report,
 *          wikimem_ingest_url, wikimem_ask, wikimem_lint
 *
 * All imports are dynamic to keep MCP server startup fast.
 */

import { basename, dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// ─── wikimem_list_connectors ──────────────────────────────────────────────

/**
 * List all OAuth connectors (platform syncs) with their connection status.
 * Reads stored tokens from .wikimem/tokens.json and cross-references with
 * connector configs to show what's connected vs available.
 */
export async function handleListConnectors(
  vaultRoot: string,
  _args: Record<string, unknown>,
): Promise<unknown> {
  const SUPPORTED = ['github', 'slack', 'google', 'gmail', 'gdrive', 'linear', 'notion', 'jira'];

  // Read stored OAuth tokens
  const tokensPath = join(vaultRoot, '.wikimem', 'tokens.json');
  let tokens: Record<string, { access_token: string; connectedAt?: string; scope?: string }> = {};
  if (existsSync(tokensPath)) {
    try {
      tokens = JSON.parse(readFileSync(tokensPath, 'utf-8')) as typeof tokens;
    } catch { /* ignore parse errors */ }
  }

  // Also read folder/git-repo connectors
  const connectorsPath = join(vaultRoot, '.wikimem-connectors.json');
  let folderConnectors: Array<{ id: string; name: string; type: string; status: string; lastSyncAt?: string; totalFiles?: number }> = [];
  if (existsSync(connectorsPath)) {
    try {
      folderConnectors = JSON.parse(readFileSync(connectorsPath, 'utf-8')) as typeof folderConnectors;
    } catch { /* ignore */ }
  }

  const oauthConnectors = SUPPORTED.map((provider) => {
    // gmail and gdrive share the 'google' token
    const tokenKey = (provider === 'gmail' || provider === 'gdrive') ? 'google' : provider;
    const token = tokens[tokenKey];
    return {
      provider,
      type: 'oauth',
      connected: !!(token?.access_token),
      connectedAt: token?.connectedAt ?? null,
      scope: token?.scope ?? null,
    };
  });

  return {
    oauth: oauthConnectors,
    folders: folderConnectors.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      lastSyncAt: c.lastSyncAt ?? null,
      totalFiles: c.totalFiles ?? 0,
    })),
    summary: {
      oauthConnected: oauthConnectors.filter((c) => c.connected).length,
      oauthAvailable: SUPPORTED.length,
      folderConnectors: folderConnectors.length,
    },
    hint: 'Use wikimem_connect to start OAuth flow. Use wikimem_sync to sync a connected provider.',
  };
}

// ─── wikimem_connect ──────────────────────────────────────────────────────

/**
 * Start the OAuth connection flow for a provider.
 * For CLI environments, this outputs the OAuth URL and instructions.
 * For web environments, users should visit wikimem serve → Settings → Connectors.
 */
export async function handleConnect(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const provider = args['provider'];
  if (typeof provider !== 'string' || !provider.trim()) {
    throw { code: -32602, message: 'provider is required (github | slack | google | gmail | gdrive | linear | notion | jira)' };
  }

  const p = provider.trim().toLowerCase();
  const OAUTH_PROVIDERS = ['github', 'slack', 'google', 'gmail', 'gdrive', 'linear', 'notion', 'jira'];
  if (!OAUTH_PROVIDERS.includes(p)) {
    throw { code: -32602, message: `Unknown provider "${p}". Supported: ${OAUTH_PROVIDERS.join(', ')}` };
  }

  // Check if already connected
  const tokensPath = join(vaultRoot, '.wikimem', 'tokens.json');
  if (existsSync(tokensPath)) {
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf-8')) as Record<string, { access_token?: string }>;
    const tokenKey = (p === 'gmail' || p === 'gdrive') ? 'google' : p;
    if (tokens[tokenKey]?.access_token) {
      return {
        provider: p,
        alreadyConnected: true,
        message: `${p} is already connected. Use wikimem_sync to sync content.`,
        hint: 'Run wikimem_list_connectors to see all connection statuses.',
      };
    }
  }

  // Build the OAuth URL for the web UI flow
  const oauthUrl = `http://localhost:3456/api/auth/${p}`;
  const credentials = args['credentials'];

  // If credentials are passed directly (for automated setups), validate and store
  if (credentials && typeof credentials === 'object' && credentials !== null) {
    const creds = credentials as Record<string, unknown>;
    const accessToken = creds['access_token'];
    if (typeof accessToken === 'string' && accessToken.trim()) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(vaultRoot, '.wikimem'), { recursive: true });

      const tokenKey = (p === 'gmail' || p === 'gdrive') ? 'google' : p;
      let existing: Record<string, unknown> = {};
      if (existsSync(tokensPath)) {
        try { existing = JSON.parse(readFileSync(tokensPath, 'utf-8')) as typeof existing; } catch { /* ignore */ }
      }

      existing[tokenKey] = {
        access_token: accessToken,
        refresh_token: creds['refresh_token'] ?? null,
        connectedAt: new Date().toISOString(),
        scope: creds['scope'] ?? null,
      };

      writeFileSync(tokensPath, JSON.stringify(existing, null, 2), 'utf-8');

      return {
        provider: p,
        connected: true,
        message: `${p} connected successfully via provided credentials.`,
        hint: 'Use wikimem_sync to start syncing content.',
      };
    }
  }

  return {
    provider: p,
    connected: false,
    oauthUrl,
    instructions: [
      `Option A (Web UI): Run \`wikimem serve\` → open http://localhost:3456 → Settings → Connectors → Connect ${p}`,
      `Option B (CLI): Run \`wikimem connect ${p}\` in your terminal for device flow`,
      `Option C (Direct): Call wikimem_connect with credentials: { access_token: "..." }`,
    ],
    message: `${p} requires OAuth authorization. See instructions to complete the connection.`,
  };
}

// ─── wikimem_sync ─────────────────────────────────────────────────────────

/**
 * Sync a connected OAuth provider into the wiki vault.
 * Accepts optional filters to control what gets synced (date range, channels, labels, etc.)
 */
export async function handleSyncProvider(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const provider = args['provider'];
  if (typeof provider !== 'string' || !provider.trim()) {
    throw { code: -32602, message: 'provider is required (github | slack | google | gmail | gdrive | linear | notion | jira)' };
  }

  const p = provider.trim().toLowerCase();

  // Build filters from args
  const rawFilters = args['filters'];
  const filters = (rawFilters && typeof rawFilters === 'object' && !Array.isArray(rawFilters))
    ? rawFilters as Record<string, unknown>
    : {};

  const { syncProvider } = await import('./core/sync/index.js');
  const result = await syncProvider(p, vaultRoot, {
    maxItems: typeof filters['maxItems'] === 'number' ? filters['maxItems'] : undefined,
    since: typeof filters['since'] === 'string' ? filters['since'] : undefined,
    query: typeof filters['query'] === 'string' ? filters['query'] : undefined,
    labels: Array.isArray(filters['labels']) ? filters['labels'] as string[] : undefined,
    channels: Array.isArray(filters['channels']) ? filters['channels'] as string[] : undefined,
    repos: Array.isArray(filters['repos']) ? filters['repos'] as string[] : undefined,
    projectKeys: Array.isArray(filters['projectKeys']) ? filters['projectKeys'] as string[] : undefined,
    databaseIds: Array.isArray(filters['databaseIds']) ? filters['databaseIds'] as string[] : undefined,
    folderId: typeof filters['folderId'] === 'string' ? filters['folderId'] : undefined,
    topics: Array.isArray(filters['topics']) ? filters['topics'] as string[] : undefined,
  });

  return {
    provider: result.provider,
    success: result.errors.length === 0,
    filesWritten: result.filesWritten,
    duration: result.duration,
    errors: result.errors,
    message: result.errors.length === 0
      ? `Synced ${result.filesWritten} file(s) from ${p} in ${result.duration}ms.`
      : `Sync completed with ${result.errors.length} error(s). ${result.filesWritten} file(s) written.`,
    hint: result.errors.length > 0 ? 'Check errors above. Run wikimem_list_connectors to verify connection.' : undefined,
  };
}

// ─── wikimem_preview ─────────────────────────────────────────────────────

/**
 * Preview what would be synced from a provider without writing any files.
 * Returns item metadata, counts, and cost estimates.
 */
export async function handlePreview(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const provider = args['provider'];
  if (typeof provider !== 'string' || !provider.trim()) {
    throw { code: -32602, message: 'provider is required (github | slack | google | gmail | gdrive | linear | notion | jira)' };
  }

  const p = provider.trim().toLowerCase();

  const rawFilters = args['filters'];
  const filters = (rawFilters && typeof rawFilters === 'object' && !Array.isArray(rawFilters))
    ? rawFilters as Record<string, unknown>
    : {};

  const { previewProvider } = await import('./core/sync/index.js');
  const result = await previewProvider(p, vaultRoot, {
    maxItems: typeof filters['maxItems'] === 'number' ? filters['maxItems'] : undefined,
    since: typeof filters['since'] === 'string' ? filters['since'] : undefined,
    query: typeof filters['query'] === 'string' ? filters['query'] : undefined,
    labels: Array.isArray(filters['labels']) ? filters['labels'] as string[] : undefined,
    channels: Array.isArray(filters['channels']) ? filters['channels'] as string[] : undefined,
    repos: Array.isArray(filters['repos']) ? filters['repos'] as string[] : undefined,
    projectKeys: Array.isArray(filters['projectKeys']) ? filters['projectKeys'] as string[] : undefined,
    databaseIds: Array.isArray(filters['databaseIds']) ? filters['databaseIds'] as string[] : undefined,
    folderId: typeof filters['folderId'] === 'string' ? filters['folderId'] : undefined,
  });

  return {
    provider: result.provider,
    totalItems: result.totalItems,
    itemsToSync: result.items.length,
    estimatedTokens: result.estimatedTokens,
    costEstimate: result.costEstimate,
    errors: result.errors,
    items: result.items.map((item) => ({
      id: item.id,
      title: item.title,
      date: item.date,
      type: item.type,
      sizeEstimate: item.sizeEstimate,
    })),
    message: result.errors.length === 0
      ? `Preview: ${result.items.length} of ${result.totalItems} item(s) would be synced. Est. cost: ${result.costEstimate}`
      : `Preview failed: ${result.errors.join('; ')}`,
    hint: 'Use wikimem_sync to perform the actual sync.',
  };
}

// ─── wikimem_run_observer ─────────────────────────────────────────────────

/**
 * Trigger the observer/self-improvement engine.
 * Scores pages, finds orphans, flags contradictions, identifies gaps.
 * Optionally auto-improves weak pages using LLM.
 */
export async function handleRunObserver(
  config: VaultConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const maxBudget = typeof args['budget'] === 'number' ? args['budget'] : 1.0;
  const autoImprove = args['autoImprove'] === true;
  const maxPages = typeof args['maxPages'] === 'number' ? args['maxPages'] : undefined;

  const { runObserver } = await import('./core/observer.js');
  const report = await runObserver(config, {
    maxPagesToReview: maxPages,
    maxBudget,
    autoImprove,
  });

  const weakPages = report.scores
    .filter((s) => s.score < s.maxScore * 0.6)
    .slice(0, 15)
    .map((s) => ({ title: s.title, score: s.score, maxScore: s.maxScore, topIssue: s.issues[0] ?? null }));

  const improvedCount = report.improvements?.filter((i) => i.improved).length ?? 0;

  return {
    date: report.date,
    totalPages: report.totalPages,
    pagesReviewed: report.pagesReviewed,
    averageScore: report.averageScore,
    maxScore: report.maxScore,
    weakPageCount: weakPages.length,
    weakPages,
    orphanCount: report.orphans.length,
    orphans: report.orphans.slice(0, 10).map((o) => o.title),
    gapCount: report.gaps.length,
    gaps: report.gaps.slice(0, 8),
    contradictionCount: report.contradictions.length,
    topIssues: report.topIssues.slice(0, 5),
    crossLinkOpportunities: report.crossLinks?.length ?? 0,
    pageSuggestions: report.pageSuggestions?.slice(0, 5) ?? [],
    autoImprove,
    improvedCount,
    budgetUsed: maxBudget,
    message: `Observer run complete. ${report.pagesReviewed} pages reviewed, avg score ${report.averageScore}/${report.maxScore}. ${improvedCount} pages auto-improved.`,
    hint: 'Full report saved to .wikimem/observer-reports/. Use wikimem_get_report to retrieve it.',
  };
}

// ─── wikimem_ingest_url ───────────────────────────────────────────────────

/**
 * Ingest a URL directly into the vault. Distinct from wikimem_ingest (which
 * also accepts file paths) — this accepts only URLs and explicitly labels the
 * source type for clarity in Claude Code workflows.
 */
export async function handleIngestUrl(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = args['url'];
  if (typeof url !== 'string' || !url.trim()) {
    throw { code: -32602, message: 'url must be a non-empty string' };
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw { code: -32602, message: 'url must start with http:// or https://' };
  }

  const { spawn } = await import('node:child_process');
  const wikimemBin = join(__dirname, 'index.js');

  const cliArgs = [wikimemBin, 'ingest', url.trim(), '--vault', vaultRoot];

  const tags = args['tags'];
  if (Array.isArray(tags) && tags.length > 0) {
    cliArgs.push('--tags', (tags as string[]).join(','));
  }

  const category = args['category'];
  if (typeof category === 'string' && category.trim()) {
    cliArgs.push('--category', category.trim());
  }

  const result = await new Promise<{ success: boolean; output: string }>((res) => {
    const proc = spawn(process.execPath, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code) => res({ success: code === 0, output }));
    proc.on('error', (err) => res({ success: false, output: err.message }));
  });

  return {
    url: url.trim(),
    tags: Array.isArray(tags) ? tags : [],
    category: typeof category === 'string' ? category.trim() : null,
    success: result.success,
    output: result.output.trim(),
    message: result.success
      ? `Successfully ingested URL: ${url.trim()}`
      : `URL ingest failed. See output for details.`,
  };
}

// ─── wikimem_ask ──────────────────────────────────────────────────────────

/**
 * Query the wiki vault with a natural language question.
 * Uses BM25 search to retrieve relevant pages, then synthesises an answer
 * with cited page titles via the configured LLM provider.
 */
export async function handleAsk(
  config: VaultConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const question = args['question'];
  if (typeof question !== 'string' || !question.trim()) {
    throw { code: -32602, message: 'question must be a non-empty string' };
  }

  const fileBack = args['fileBack'] === true;
  const searchMode = typeof args['searchMode'] === 'string'
    ? (args['searchMode'] as 'bm25' | 'semantic' | 'hybrid')
    : 'bm25';

  const { loadConfig } = await import('./core/config.js');
  const userConfig = loadConfig(config.configPath);

  const { createProviderFromUserConfig } = await import('./providers/index.js');
  const provider = createProviderFromUserConfig(userConfig);

  const { queryWiki } = await import('./core/query.js');
  const result = await queryWiki(question.trim(), config, provider, {
    fileBack,
    searchMode,
  });

  return {
    question: question.trim(),
    answer: result.answer,
    sourcesConsulted: result.sourcesConsulted,
    filedAs: result.filedAs ?? null,
    searchMode,
  };
}

// ─── wikimem_lint ─────────────────────────────────────────────────────────

/**
 * Run the wiki health checker. Finds orphan pages, missing cross-links,
 * pages without summaries, contradictions, and other quality issues.
 * Returns structured issues with severity and page attribution.
 */
export async function handleLint(
  config: VaultConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const fix = args['fix'] === true;

  const { loadConfig } = await import('./core/config.js');
  const userConfig = loadConfig(config.configPath);

  const { createProviderFromUserConfig } = await import('./providers/index.js');
  const provider = createProviderFromUserConfig(userConfig);

  const { lintWiki } = await import('./core/lint.js');
  const result = await lintWiki(config, provider, { fix });

  const byCategory = result.issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.category] = (acc[i.category] ?? 0) + 1;
    return acc;
  }, {});

  const errorCount = result.issues.filter((i) => i.severity === 'error').length;
  const warningCount = result.issues.filter((i) => i.severity === 'warning').length;
  const fixedCount = result.issues.filter((i) => i.fixed).length;

  return {
    score: result.score,
    healthy: result.issues.length === 0,
    issueCount: result.issues.length,
    errorCount,
    warningCount,
    fixedCount,
    byCategory,
    issues: result.issues.map((i) => ({
      category: i.category,
      severity: i.severity,
      message: i.message,
      page: i.page ?? null,
      fixed: i.fixed ?? false,
    })),
    message: result.issues.length === 0
      ? 'Wiki is healthy. No issues found.'
      : `Found ${errorCount} error(s) and ${warningCount} warning(s). Score: ${result.score}/100.${fix && fixedCount > 0 ? ` Auto-fixed ${fixedCount} issue(s).` : ''}`,
    hint: result.issues.length > 0 && !fix
      ? 'Set fix=true to auto-fix issues where possible, or run wikimem_improve for LLM-powered fixes.'
      : undefined,
  };
}

// ─── wikimem_get_report ───────────────────────────────────────────────────

/**
 * Get the latest (or a specific date's) observer report.
 * Returns the full structured report from .wikimem/observer-reports/.
 */
export async function handleGetReport(
  vaultRoot: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { getObserverReportsDir } = await import('./core/observer.js');
  const reportsDir = getObserverReportsDir(vaultRoot);

  if (!existsSync(reportsDir)) {
    return {
      found: false,
      message: 'No observer reports found. Run wikimem_run_observer first.',
    };
  }

  const dateArg = typeof args['date'] === 'string' ? args['date'].trim() : null;

  let reportFile: string | null = null;

  if (dateArg) {
    const target = join(reportsDir, `${dateArg}.json`);
    if (existsSync(target)) {
      reportFile = target;
    } else {
      return {
        found: false,
        date: dateArg,
        message: `No report found for date "${dateArg}". Check .wikimem/observer-reports/ for available reports.`,
      };
    }
  } else {
    // Get latest report by sorting filenames (ISO date format sorts lexicographically)
    const files = readdirSync(reportsDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) {
      return {
        found: false,
        message: 'No observer reports found. Run wikimem_run_observer first.',
      };
    }

    reportFile = join(reportsDir, files[0] as string);
  }

  try {
    const raw = readFileSync(reportFile, 'utf-8');
    const report = JSON.parse(raw) as {
      date: string;
      generatedAt: string;
      totalPages: number;
      pagesReviewed: number;
      averageScore: number;
      maxScore: number;
      orphans: Array<{ title: string }>;
      gaps: Array<unknown>;
      contradictions: Array<unknown>;
      topIssues: Array<{ issue: string; count: number }>;
      improvements: Array<{ improved: boolean }>;
      experimentInsights?: string[];
    };

    // Return a condensed version (full report can be huge)
    return {
      found: true,
      date: report.date,
      generatedAt: report.generatedAt,
      totalPages: report.totalPages,
      pagesReviewed: report.pagesReviewed,
      averageScore: report.averageScore,
      maxScore: report.maxScore,
      orphanCount: report.orphans?.length ?? 0,
      gapCount: report.gaps?.length ?? 0,
      contradictionCount: report.contradictions?.length ?? 0,
      topIssues: report.topIssues?.slice(0, 10) ?? [],
      improvementsApplied: report.improvements?.filter((i) => i.improved).length ?? 0,
      experimentInsights: report.experimentInsights?.slice(0, 5) ?? [],
      message: `Report from ${report.date}: ${report.pagesReviewed}/${report.totalPages} pages, avg score ${report.averageScore}/${report.maxScore}.`,
    };
  } catch (err) {
    return {
      found: false,
      error: err instanceof Error ? err.message : String(err),
      message: 'Failed to read report file.',
    };
  }
}
