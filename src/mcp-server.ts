/**
 * WikiMem MCP Server — JSON-RPC 2.0 over stdin/stdout.
 *
 * Implements the Model Context Protocol without the SDK dependency.
 * Reads newline-delimited JSON from stdin, writes responses to stdout.
 *
 * Tools exposed (19):
 *   wikimem_search           — BM25 keyword search over wiki pages
 *   wikimem_read             — Read a specific wiki page by title or filename
 *   wikimem_list             — List all wiki pages with metadata
 *   wikimem_status           — Vault statistics (page count, words, orphans, …)
 *   wikimem_ingest           — Ingest a file or URL into the vault (async)
 *   wikimem_observe          — Quality observer: scores, orphans, contradictions, gaps
 *   wikimem_improve          — LLM-powered improvement suggestions for weak pages
 *   wikimem_pipeline         — Pipeline status: recent runs, connector health
 *   wikimem_scrape           — Scrape a URL and ingest into the vault
 *   wikimem_connectors       — Manage data source connectors (list/add/remove/sync)
 *   wikimem_list_connectors  — List all connectors (OAuth + folder) with status
 *   wikimem_connect          — Start OAuth connection flow for a provider
 *   wikimem_sync             — Sync a connected provider with optional filters
 *   wikimem_preview          — Preview what would be synced without writing files
 *   wikimem_run_observer     — Trigger the observer/self-improvement engine
 *   wikimem_get_report       — Get latest (or specific date) observer report
 *   wikimem_ingest_url       — Ingest a URL directly into the vault
 *   wikimem_ask              — Query vault with natural language, returns LLM answer + citations
 *   wikimem_lint             — Run wiki health check, returns structured issues
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVaultConfig, getVaultStats, listWikiPages, readWikiPage } from './core/vault.js';
import { searchPages } from './search/index.js';
import {
  handleObserve, handleImprove, handlePipeline, handleScrape, handleConnectors,
  handleListConnectors, handleConnect, handleSyncProvider, handlePreview,
  handleRunObserver, handleGetReport,
  handleIngestUrl, handleAsk, handleLint,
} from './mcp-tools-extended.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── JSON-RPC types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── MCP Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'wikimem_search',
    description: 'Search wiki pages using BM25 keyword ranking. Returns ranked results with title, path, and a content snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results to return (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'wikimem_read',
    description: 'Read a specific wiki page by title or filename. Returns frontmatter, full content, wikilinks, and word count.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title or filename (without .md extension)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'wikimem_list',
    description: 'List all wiki pages in the vault with their title, type, tags, and summary from frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter by page type (sources | entities | concepts | syntheses). Omit for all pages.',
        },
      },
    },
  },
  {
    name: 'wikimem_status',
    description: 'Get vault statistics: page count, word count, source count, wikilink count, orphan pages, last updated.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wikimem_ingest',
    description: 'Ingest a file, folder, or URL into the vault. Spawns the wikimem ingest CLI process.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'File path, directory path, or URL to ingest' },
      },
      required: ['source'],
    },
  },
  {
    name: 'wikimem_observe',
    description: 'Run the quality observer on the vault. Scores every page for freshness, readability, cross-linking, and tags. Returns weak pages, orphans, contradictions, and knowledge gaps.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Score a single page by title (omit for vault-wide report)' },
      },
    },
  },
  {
    name: 'wikimem_improve',
    description: 'Trigger improvement suggestions for weak wiki pages. Returns proposed actions (reorganize, cross-link, add summaries) and optionally applies them.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Improve a specific page by title (omit for vault-wide improvement)' },
        autoApply: { type: 'boolean', description: 'When true, automatically apply improvements instead of dry-run (default false)' },
      },
    },
  },
  {
    name: 'wikimem_pipeline',
    description: 'Get pipeline status: recent ingest runs, current run state, and connector sync health.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of recent runs to return (default 10)' },
      },
    },
  },
  {
    name: 'wikimem_scrape',
    description: 'Scrape a URL and ingest its content into the wiki vault. Fetches the page, extracts text, and runs it through the ingest pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to scrape and ingest' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to associate with the ingested content',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'wikimem_connectors',
    description: 'Manage data source connectors: list, add, remove, or sync folder/repo connectors that auto-ingest content into the wiki.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'sync'],
          description: 'Action to perform on connectors',
        },
        id: { type: 'string', description: 'Connector ID (required for remove and sync)' },
        name: { type: 'string', description: 'Connector display name (required for add)' },
        type: {
          type: 'string',
          enum: ['folder', 'git-repo'],
          description: 'Connector type (required for add)',
        },
        path: { type: 'string', description: 'Local path to folder or repo (required for add)' },
        url: { type: 'string', description: 'Remote URL for git-repo connectors (optional for add)' },
        autoSync: { type: 'boolean', description: 'Enable auto-sync file watching (optional for add, default false)' },
        includeGlobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'File patterns to include, e.g. ["*.md", "*.txt"] (optional for add)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'wikimem_list_connectors',
    description: 'List all connectors (OAuth platform integrations + local folder/repo connectors) with their connection status. Shows which providers are connected and when they last synced.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wikimem_connect',
    description: 'Start the OAuth connection flow for a platform provider (github, slack, google, gmail, gdrive, linear, notion, jira). Returns OAuth URL and instructions, or accepts credentials directly for automated setups.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider to connect: github | slack | google | gmail | gdrive | linear | notion | jira',
        },
        credentials: {
          type: 'object',
          description: 'Optional — pass { access_token, refresh_token?, scope? } directly to skip the OAuth UI flow.',
          properties: {
            access_token: { type: 'string' },
            refresh_token: { type: 'string' },
            scope: { type: 'string' },
          },
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'wikimem_sync',
    description: 'Sync a connected OAuth provider into the wiki vault. Accepts optional filters to limit scope (date range, specific channels, labels, repos, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider to sync: github | slack | google | gmail | gdrive | linear | notion | jira',
        },
        filters: {
          type: 'object',
          description: 'Optional sync filters',
          properties: {
            maxItems: { type: 'number', description: 'Max number of items to sync' },
            since: { type: 'string', description: 'ISO date — only sync items after this date' },
            query: { type: 'string', description: 'Free-text search applied at the API level' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Gmail: label IDs to include' },
            channels: { type: 'array', items: { type: 'string' }, description: 'Slack: channel IDs or names' },
            repos: { type: 'array', items: { type: 'string' }, description: 'GitHub: repos in owner/name format' },
            projectKeys: { type: 'array', items: { type: 'string' }, description: 'Jira: project keys' },
            databaseIds: { type: 'array', items: { type: 'string' }, description: 'Notion: database IDs' },
            folderId: { type: 'string', description: 'Google Drive: folder ID to restrict sync' },
          },
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'wikimem_preview',
    description: 'Preview what would be synced from a provider without writing any files. Returns item list, counts, and LLM cost estimates.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider to preview: github | slack | google | gmail | gdrive | linear | notion | jira',
        },
        filters: {
          type: 'object',
          description: 'Optional filters (same as wikimem_sync)',
          properties: {
            maxItems: { type: 'number' },
            since: { type: 'string' },
            query: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            channels: { type: 'array', items: { type: 'string' } },
            repos: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'wikimem_run_observer',
    description: 'Trigger the self-improvement observer: scores all pages, finds orphans, flags contradictions, identifies knowledge gaps, discovers cross-link opportunities. Optionally auto-improves weak pages.',
    inputSchema: {
      type: 'object',
      properties: {
        budget: { type: 'number', description: 'Maximum LLM cost budget in USD (default 1.0). Set 0 to disable auto-improve.' },
        autoImprove: { type: 'boolean', description: 'When true, automatically improve weak pages using LLM (default false)' },
        maxPages: { type: 'number', description: 'Maximum pages to review (omit for all pages)' },
      },
    },
  },
  {
    name: 'wikimem_get_report',
    description: 'Get the latest observer report (or a specific date\'s report). Returns page scores, orphans, gaps, and improvement results.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date string YYYY-MM-DD to get a specific report (omit for latest)' },
      },
    },
  },
  {
    name: 'wikimem_ingest_url',
    description: 'Ingest a URL into the wiki vault. Fetches the page, extracts text, and runs it through the ingest pipeline. Use this when you want to add a web resource to the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch and ingest (must start with http:// or https://)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to associate with the ingested page',
        },
        category: {
          type: 'string',
          description: 'Optional page category: sources | entities | concepts | syntheses',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'wikimem_ask',
    description: 'Query the wiki vault with a natural language question. Uses BM25 retrieval to find relevant pages and synthesises a cited answer via the configured LLM provider.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language question to ask against the wiki' },
        fileBack: {
          type: 'boolean',
          description: 'When true, save the answer as a new synthesis wiki page (default false)',
        },
        searchMode: {
          type: 'string',
          enum: ['bm25', 'semantic', 'hybrid'],
          description: 'Retrieval strategy: bm25 (default), semantic, or hybrid',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'wikimem_lint',
    description: 'Run the wiki health checker. Finds orphan pages, missing cross-links, pages without summaries, contradictions, and other quality issues. Returns structured issues with severity and per-page attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        fix: {
          type: 'boolean',
          description: 'When true, auto-fix issues where possible (default false — dry run)',
        },
      },
    },
  },
];

// ─── Server state ──────────────────────────────────────────────────────────

let vaultRoot = process.cwd();
let initialized = false;

// ─── Tool handlers ─────────────────────────────────────────────────────────

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const config = getVaultConfig(vaultRoot);

  switch (name) {
    case 'wikimem_search': {
      const query = args['query'];
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;
      if (typeof query !== 'string' || !query.trim()) {
        throw { code: -32602, message: 'query must be a non-empty string' };
      }

      const allPages = listWikiPages(config.wikiDir);
      const ranked = await searchPages(query, allPages, { mode: 'bm25', limit });

      const results = ranked.map((path) => {
        try {
          const page = readWikiPage(path);
          const snippet = page.content.slice(0, 300).replace(/\n+/g, ' ').trim();
          return {
            title: page.title,
            path,
            snippet: snippet + (page.content.length > 300 ? '…' : ''),
            type: page.frontmatter['type'] ?? 'unknown',
            tags: page.frontmatter['tags'] ?? [],
          };
        } catch {
          return { title: basename(path, '.md'), path, snippet: '', type: 'unknown', tags: [] };
        }
      });

      return {
        query,
        count: results.length,
        results,
      };
    }

    case 'wikimem_read': {
      const titleArg = args['title'];
      if (typeof titleArg !== 'string' || !titleArg.trim()) {
        throw { code: -32602, message: 'title must be a non-empty string' };
      }

      const allPages = listWikiPages(config.wikiDir);
      const target = titleArg.toLowerCase();

      // Match by frontmatter title, then by filename stem
      const match = allPages.find((p) => {
        const stem = basename(p, '.md').toLowerCase();
        if (stem === target) return true;
        try {
          const page = readWikiPage(p);
          return page.title.toLowerCase() === target;
        } catch {
          return false;
        }
      });

      if (!match) {
        // Try fuzzy: find page whose title/stem includes the query
        const fuzzy = allPages.find((p) => {
          const stem = basename(p, '.md').toLowerCase();
          if (stem.includes(target)) return true;
          try {
            const page = readWikiPage(p);
            return page.title.toLowerCase().includes(target);
          } catch {
            return false;
          }
        });

        if (!fuzzy) {
          return {
            found: false,
            message: `No wiki page found matching "${titleArg}"`,
            hint: 'Use wikimem_list to see all available pages or wikimem_search for fuzzy matching',
          };
        }

        const page = readWikiPage(fuzzy);
        return {
          found: true,
          title: page.title,
          path: fuzzy,
          frontmatter: page.frontmatter,
          content: page.content,
          wikilinks: page.wikilinks,
          wordCount: page.wordCount,
        };
      }

      const page = readWikiPage(match);
      return {
        found: true,
        title: page.title,
        path: match,
        frontmatter: page.frontmatter,
        content: page.content,
        wikilinks: page.wikilinks,
        wordCount: page.wordCount,
      };
    }

    case 'wikimem_list': {
      const typeFilter = typeof args['type'] === 'string' ? args['type'].toLowerCase() : null;
      const allPages = listWikiPages(config.wikiDir);

      const pages = allPages.flatMap((p) => {
        try {
          const page = readWikiPage(p);
          const pageType = typeof page.frontmatter['type'] === 'string'
            ? page.frontmatter['type'].toLowerCase()
            : 'unknown';

          if (typeFilter && pageType !== typeFilter) return [];

          return [{
            title: page.title,
            path: p,
            type: pageType,
            tags: page.frontmatter['tags'] ?? [],
            summary: page.frontmatter['summary'] ?? '',
            wordCount: page.wordCount,
            updated: page.frontmatter['updated'] ?? '',
          }];
        } catch {
          return [];
        }
      });

      return {
        vault: vaultRoot,
        count: pages.length,
        filter: typeFilter ?? 'all',
        pages,
      };
    }

    case 'wikimem_status': {
      if (!existsSync(config.schemaPath)) {
        return {
          initialized: false,
          message: 'Not a wikimem vault. Run `wikimem init` first.',
        };
      }

      const stats = getVaultStats(config);
      return {
        initialized: true,
        vault: vaultRoot,
        pages: stats.pageCount,
        words: stats.wordCount,
        sources: stats.sourceCount,
        wikilinks: stats.wikilinks,
        orphanPages: stats.orphanPages,
        lastUpdated: stats.lastUpdated,
      };
    }

    case 'wikimem_ingest': {
      const source = args['source'];
      if (typeof source !== 'string' || !source.trim()) {
        throw { code: -32602, message: 'source must be a non-empty string' };
      }

      // Spawn the CLI ingest command in a child process
      const { spawn } = await import('node:child_process');
      const wikimemBin = join(__dirname, 'index.js');

      const result = await new Promise<{ success: boolean; output: string }>((res) => {
        const proc = spawn(
          process.execPath,
          [wikimemBin, 'ingest', source, '--vault', vaultRoot],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        let output = '';
        proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
        proc.on('close', (code) => res({ success: code === 0, output }));
        proc.on('error', (err) => res({ success: false, output: err.message }));
      });

      return {
        source,
        success: result.success,
        output: result.output.trim(),
        message: result.success
          ? `Successfully ingested: ${source}`
          : `Ingest failed. See output for details.`,
      };
    }

    case 'wikimem_observe':
      return handleObserve(config, args);

    case 'wikimem_improve':
      return handleImprove(config, args);

    case 'wikimem_pipeline':
      return handlePipeline(vaultRoot, args);

    case 'wikimem_scrape':
      return handleScrape(vaultRoot, args);

    case 'wikimem_connectors':
      return handleConnectors(vaultRoot, args);

    case 'wikimem_list_connectors':
      return handleListConnectors(vaultRoot, args);

    case 'wikimem_connect':
      return handleConnect(vaultRoot, args);

    case 'wikimem_sync':
      return handleSyncProvider(vaultRoot, args);

    case 'wikimem_preview':
      return handlePreview(vaultRoot, args);

    case 'wikimem_run_observer':
      return handleRunObserver(config, args);

    case 'wikimem_get_report':
      return handleGetReport(vaultRoot, args);

    case 'wikimem_ingest_url':
      return handleIngestUrl(vaultRoot, args);

    case 'wikimem_ask':
      return handleAsk(config, args);

    case 'wikimem_lint':
      return handleLint(config, args);

    default:
      throw { code: -32601, message: `Unknown tool: ${name}` };
  }
}

// ─── JSON-RPC request dispatcher ───────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  // Notifications (no id) don't require a response
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      initialized = true;
    }
    return null;
  }

  try {
    switch (method) {
      case 'initialize': {
        const p = params as Record<string, unknown> | undefined;
        const clientProtocol = (p?.['protocolVersion'] as string) ?? '2024-11-05';
        void clientProtocol; // we accept any version

        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'wikimem', version: getVersion() },
          },
        };
      }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS },
        };

      case 'tools/call': {
        const p = params as { name: string; arguments?: Record<string, unknown> } | undefined;
        if (!p?.name) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Missing tool name in params' },
          };
        }

        const toolResult = await handleToolCall(p.name, p.arguments ?? {});

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: JSON.stringify(toolResult, null, 2) },
            ],
          },
        };
      }

      // Gracefully handle ping and other optional lifecycle methods
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    const rpcErr = err as { code?: number; message?: string };
    if (typeof rpcErr.code === 'number') {
      return { jsonrpc: '2.0', id, error: { code: rpcErr.code, message: rpcErr.message ?? 'Unknown error' } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// ─── Main entrypoint ───────────────────────────────────────────────────────

export async function startMcpServer(vault: string): Promise<void> {
  vaultRoot = resolve(vault);

  // MCP servers must NOT write anything to stdout before receiving initialize.
  // All startup noise goes to stderr.
  process.stderr.write(`[wikimem-mcp] Starting. Vault: ${vaultRoot}\n`);

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    handleRequest(req)
      .then((response) => {
        if (response) send(response);
      })
      .catch((err) => {
        send({
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      });
  });

  rl.on('close', () => {
    process.stderr.write('[wikimem-mcp] stdin closed, shutting down.\n');
    process.exit(0);
  });
}
