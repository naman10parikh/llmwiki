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
  const links: GraphLink[] = [];
  const incomingCount = new Map<string, number>();

  for (const pagePath of pages) {
    const page = readWikiPage(pagePath);
    const id = basename(pagePath, '.md');
    const category = (page.frontmatter['category'] as string) ?? 'uncategorized';
    nodesMap.set(id, {
      id,
      title: page.title,
      wordCount: page.wordCount,
      category,
      linksOut: page.wikilinks.length,
      linksIn: 0,
    });

    for (const link of page.wikilinks) {
      links.push({ source: id, target: link });
      incomingCount.set(link, (incomingCount.get(link) ?? 0) + 1);
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
      const match = pages.find((p) => basename(p, '.md') === title);
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
