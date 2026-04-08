import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVaultConfig, getVaultStats, listWikiPages, readWikiPage } from '../core/vault.js';
import type { VaultConfig } from '../core/vault.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

interface GraphNode {
  id: string;
  title: string;
  wordCount: number;
  category: string;
  linksOut: number;
  linksIn: number;
}

interface GraphLink {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

function buildGraph(config: VaultConfig): GraphData {
  const pages = listWikiPages(config.wikiDir);
  const nodesMap = new Map<string, GraphNode>();
  const titleToId = new Map<string, string>();
  const links: GraphLink[] = [];
  const incomingCount = new Map<string, number>();

  // Cache all pages and build lookups
  const pageData = pages.map((p) => {
    const page = readWikiPage(p);
    const id = basename(p, '.md');
    return { id, page };
  });

  // Build multiple lookup strategies for resolving wikilinks
  for (const { id, page } of pageData) {
    const category = (page.frontmatter['category'] as string) ?? 'uncategorized';
    nodesMap.set(id, {
      id,
      title: page.title,
      wordCount: page.wordCount,
      category,
      linksOut: page.wikilinks.length,
      linksIn: 0,
    });
    titleToId.set(page.title, id);
    titleToId.set(page.title.toLowerCase(), id);
    titleToId.set(id, id);
  }

  // Resolve wikilinks using title, lowercase title, or slugified title
  for (const { id: sourceId, page } of pageData) {
    for (const link of page.wikilinks) {
      const targetId = titleToId.get(link)
        ?? titleToId.get(link.toLowerCase())
        ?? titleToId.get(link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
      if (targetId && targetId !== sourceId) {
        links.push({ source: sourceId, target: targetId });
        incomingCount.set(targetId, (incomingCount.get(targetId) ?? 0) + 1);
      }
    }
  }

  // Update incoming link counts
  for (const [id, count] of incomingCount) {
    const node = nodesMap.get(id);
    if (node) {
      node.linksIn = count;
    }
  }

  return {
    nodes: Array.from(nodesMap.values()),
    links: links.filter((l) => nodesMap.has(l.source) && nodesMap.has(l.target)),
  };
}

interface PageInfo {
  title: string;
  path: string;
  wordCount: number;
  category: string;
  wikilinks: string[];
}

function listPages(config: VaultConfig): PageInfo[] {
  const pages = listWikiPages(config.wikiDir);
  return pages.map((p) => {
    const page = readWikiPage(p);
    return {
      title: page.title,
      path: p,
      wordCount: page.wordCount,
      category: (page.frontmatter['category'] as string) ?? 'uncategorized',
      wikilinks: page.wikilinks,
    };
  });
}

export function createServer(vaultRoot: string, port: number): void {
  const app = express();
  const config = getVaultConfig(vaultRoot);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files
  const publicDir = join(__dirname, 'public');
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // API: vault status
  app.get('/api/status', (_req, res) => {
    try {
      const stats = getVaultStats(config);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read vault status' });
    }
  });

  // API: list pages
  app.get('/api/pages', (_req, res) => {
    try {
      const pages = listPages(config);
      res.json(pages);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list pages' });
    }
  });

  // API: read single page
  app.get('/api/pages/:title', (req, res) => {
    try {
      const title = req.params['title'];
      if (!title) {
        res.status(400).json({ error: 'Missing title' });
        return;
      }
      const pages = listWikiPages(config.wikiDir);
      // Match by slug OR by frontmatter title (case-insensitive)
      const titleLower = title.toLowerCase();
      const slugified = titleLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === title || fileSlug === slugified) return true;
        try {
          const page = readWikiPage(p);
          return page.title.toLowerCase() === titleLower;
        } catch { return false; }
      });
      if (!match) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      const page = readWikiPage(match);
      res.json(page);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read page' });
    }
  });

  // API: knowledge graph data
  app.get('/api/graph', (_req, res) => {
    try {
      const graph = buildGraph(config);
      res.json(graph);
    } catch (err) {
      res.status(500).json({ error: 'Failed to build graph' });
    }
  });

  // API: upload raw file for ingestion
  app.post('/api/upload', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const filename = req.headers['x-filename'] as string | undefined;
      if (!filename) {
        res.status(400).json({ error: 'Missing x-filename header' });
        return;
      }
      const rawDir = config.rawDir;
      if (!existsSync(rawDir)) {
        mkdirSync(rawDir, { recursive: true });
      }
      const dest = join(rawDir, basename(filename));
      writeFileSync(dest, Buffer.concat(chunks));
      res.json({ status: 'uploaded', path: dest });
    });
  });

  // API: raw files list
  app.get('/api/raw', (_req, res) => {
    try {
      const rawDir = config.rawDir;
      if (!existsSync(rawDir)) {
        res.json([]);
        return;
      }
      const files = readdirSync(rawDir)
        .filter((f) => !f.startsWith('.'))
        .map((f) => {
          const full = join(rawDir, f);
          const stat = statSync(full);
          return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
        });
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list raw files' });
    }
  });

  // API: query the wiki
  app.post('/api/query', async (req, res) => {
    try {
      const { question, provider: providerName } = req.body as { question?: string; provider?: string };
      if (!question) {
        res.status(400).json({ error: 'Missing question field' });
        return;
      }
      // Dynamic import to avoid circular deps
      const { queryWiki } = await import('../core/query.js');
      const { createProvider } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProvider(providerName ?? userConfig.provider ?? 'claude');
      const result = await queryWiki(question, config, provider, { fileBack: false });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Query failed: ${msg}` });
    }
  });

  // API: ingest a URL
  app.post('/api/ingest', async (req, res) => {
    try {
      const { source } = req.body as { source?: string };
      if (!source) {
        res.status(400).json({ error: 'Missing source field' });
        return;
      }
      const { ingestSource } = await import('../core/ingest.js');
      const { createProvider } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProvider(userConfig.provider ?? 'claude');
      const result = await ingestSource(source, config, provider, { verbose: false });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Ingest failed: ${msg}` });
    }
  });

  // Serve index.html for all other routes (SPA)
  app.get('/{*path}', (_req, res) => {
    const indexPath = join(publicDir, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Web UI not found. Rebuild with pnpm build.');
    }
  });

  app.listen(port, () => {
    console.log(`\n  wikimem web UI running at http://localhost:${port}`);
    console.log(`  Vault: ${vaultRoot}\n`);
  });
}
