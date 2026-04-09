/**
 * WikiMem MCP Server — JSON-RPC 2.0 over stdin/stdout.
 *
 * Implements the Model Context Protocol without the SDK dependency.
 * Reads newline-delimited JSON from stdin, writes responses to stdout.
 *
 * Tools exposed:
 *   wikimem_search  — BM25 keyword search over wiki pages
 *   wikimem_read    — Read a specific wiki page by title or filename
 *   wikimem_list    — List all wiki pages with metadata
 *   wikimem_status  — Vault statistics (page count, words, orphans, …)
 *   wikimem_ingest  — Ingest a file or URL into the vault (async)
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { getVaultConfig, getVaultStats, listWikiPages, readWikiPage } from './core/vault.js';
import { searchPages } from './search/index.js';

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
          description: 'Filter by page type (source | entity | concept | synthesis). Omit for all pages.',
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
      const wikimemBin = join(resolve(import.meta.url.replace('file://', ''), '../../..'), 'dist/index.js');

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
    const pkgPath = join(resolve(import.meta.url.replace('file://', ''), '../../..'), 'package.json');
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
