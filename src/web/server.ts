import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVaultConfig, getVaultStats, listWikiPages, readWikiPage, writeWikiPage } from '../core/vault.js';
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

  const publicDir = join(__dirname, 'public');

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

  // API: create new page
  app.post('/api/pages', (req, res) => {
    try {
      const { title, slug, content } = req.body as { title?: string; slug?: string; content?: string };
      if (!title || !slug) {
        res.status(400).json({ error: 'Missing title or slug' });
        return;
      }
      const dest = join(config.wikiDir, `${slug}.md`);
      if (existsSync(dest)) {
        res.status(409).json({ error: 'Page already exists' });
        return;
      }
      mkdirSync(config.wikiDir, { recursive: true });
      writeFileSync(dest, content ?? `---\ntitle: "${title}"\ntype: page\n---\n\n# ${title}\n`, 'utf-8');
      res.json({ status: 'created', path: dest, title });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to create page: ${msg}` });
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

  // API: read raw page content (for editing)
  app.get('/api/wiki/page/raw', (req, res) => {
    try {
      const pagePath = req.query['path'] as string;
      if (!pagePath) {
        res.status(400).json({ error: 'Missing path query parameter' });
        return;
      }
      const resolved = resolve(pagePath);
      if (!resolved.startsWith(resolve(config.wikiDir))) {
        res.status(403).json({ error: 'Access denied: path outside wiki directory' });
        return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const raw = readFileSync(resolved, 'utf-8');
      res.json({ path: resolved, raw });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read raw page: ${msg}` });
    }
  });

  // API: save wiki page (write to disk + auto-commit)
  app.put('/api/wiki/page', async (req, res) => {
    try {
      const { path: pagePath, content, frontmatter } = req.body as {
        path?: string;
        content?: string;
        frontmatter?: Record<string, unknown>;
      };
      if (!pagePath || content === undefined) {
        res.status(400).json({ error: 'Missing path or content' });
        return;
      }
      const resolved = resolve(pagePath);
      if (!resolved.startsWith(resolve(config.wikiDir))) {
        res.status(403).json({ error: 'Access denied: path outside wiki directory' });
        return;
      }

      // Parse the raw content — if it includes frontmatter, use gray-matter
      const matter = await import('gray-matter');
      const parsed = matter.default(content);
      const finalFrontmatter = frontmatter ?? parsed.data;
      const finalContent = frontmatter ? content : parsed.content;

      writeWikiPage(resolved, finalContent, finalFrontmatter);

      // Auto-commit if git-initialized
      let commitResult = null;
      try {
        const { autoCommit, isGitRepo } = await import('../core/git.js');
        if (await isGitRepo(config.root)) {
          const title = (finalFrontmatter['title'] as string) ?? basename(resolved, '.md');
          commitResult = await autoCommit(config.root, 'manual', `edit "${title}" via web UI`);
        }
      } catch { /* non-fatal */ }

      res.json({ status: 'saved', path: resolved, commit: commitResult });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to save page: ${msg}` });
    }
  });

  // API: read raw page content (full markdown with frontmatter)
  app.get('/api/pages/:title/raw', (req, res) => {
    try {
      const title = req.params['title'];
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }
      const pages = listWikiPages(config.wikiDir);
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
      if (!match) { res.status(404).json({ error: 'Page not found' }); return; }
      const raw = readFileSync(match, 'utf-8');
      res.json({ raw, path: match, slug: basename(match, '.md') });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read raw page' });
    }
  });

  // API: update page content (full markdown with frontmatter)
  app.put('/api/pages/:title', async (req, res) => {
    try {
      const title = req.params['title'];
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }
      const { content } = req.body as { content?: string };
      if (content === undefined || content === null) {
        res.status(400).json({ error: 'Missing content field' });
        return;
      }

      const pages = listWikiPages(config.wikiDir);
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
      if (!match) { res.status(404).json({ error: 'Page not found' }); return; }

      writeFileSync(match, content, 'utf-8');

      // Extract title from new content for commit message
      const matter = await import('gray-matter');
      const parsed = matter.default(content);
      const pageTitle = (parsed.data['title'] as string) || title;

      // Auto-commit via git
      try {
        const { autoCommit } = await import('../core/git.js');
        await autoCommit(config.root, 'manual', `edit page "${pageTitle}"`);
      } catch { /* git commit is best-effort */ }

      const page = readWikiPage(match);
      res.json({ status: 'saved', page });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to save page: ${msg}` });
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

  // API: upload raw file and auto-trigger ingest
  app.post('/api/upload', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const filename = req.headers['x-filename'] as string | undefined;
      if (!filename) {
        res.status(400).json({ error: 'Missing x-filename header' });
        return;
      }
      const now = new Date().toISOString().split('T')[0] ?? '';
      const dateDir = join(config.rawDir, now);
      mkdirSync(dateDir, { recursive: true });
      const dest = join(dateDir, basename(filename));
      writeFileSync(dest, Buffer.concat(chunks));

      const autoIngest = req.headers['x-auto-ingest'] !== 'false';
      if (autoIngest) {
        try {
          const { ingestSource } = await import('../core/ingest.js');
          const { createProvider } = await import('../providers/index.js');
          const { loadConfig } = await import('../core/config.js');
          const userConfig = loadConfig(config.configPath);
          const provider = createProvider(userConfig.provider ?? 'claude');
          const result = await ingestSource(dest, config, provider, { verbose: false });
          res.json({ status: 'ingested', path: dest, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.json({ status: 'uploaded', path: dest, ingestError: msg });
        }
      } else {
        res.json({ status: 'uploaded', path: dest });
      }
    });
  });

  // API: raw files list (recursive through date-stamped subdirectories)
  app.get('/api/raw', (_req, res) => {
    try {
      const rawDir = config.rawDir;
      if (!existsSync(rawDir)) {
        res.json([]);
        return;
      }
      const files: Array<{ name: string; path: string; size: number; modified: string }> = [];
      function walkRaw(dir: string, prefix: string): void {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith('.') || entry.endsWith('.meta.json')) continue;
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walkRaw(full, prefix ? `${prefix}/${entry}` : entry);
          } else {
            files.push({
              name: prefix ? `${prefix}/${entry}` : entry,
              path: full,
              size: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        }
      }
      walkRaw(rawDir, '');
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list raw files' });
    }
  });

  // API: read raw file content (for preview)
  app.get('/api/raw/view/:filename', (req, res) => {
    try {
      const filename = req.params['filename'];
      if (!filename) { res.status(400).json({ error: 'Missing filename' }); return; }
      const decoded = decodeURIComponent(filename);
      const fullPath = join(config.rawDir, decoded);
      const resolved = resolve(fullPath);
      if (!resolved.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const ext = extname(resolved).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
      if (imageExts.includes(ext)) {
        res.sendFile(resolved);
        return;
      }
      const textExts = ['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.ts', '.js', '.py', '.go', '.rs'];
      if (textExts.includes(ext) || ext === '') {
        const content = readFileSync(resolved, 'utf-8');
        res.json({ type: 'text', content, filename: decoded });
        return;
      }
      res.json({ type: 'binary', filename: decoded, size: statSync(resolved).size, message: 'Binary file — extract with wikimem ingest' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read raw file' });
    }
  });

  // API: file tree (wiki + raw hierarchy)
  app.get('/api/tree', (_req, res) => {
    try {
      interface TreeNode {
        name: string;
        type: 'dir' | 'wiki' | 'raw';
        path: string;
        title?: string;
        category?: string;
        children?: TreeNode[];
        size?: number;
      }

      function buildWikiTree(dir: string, relPath: string): TreeNode[] {
        const nodes: TreeNode[] = [];
        if (!existsSync(dir)) return nodes;
        const entries = readdirSync(dir).sort();
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const full = join(dir, entry);
          const stat = statSync(full);
          const childPath = relPath ? `${relPath}/${entry}` : entry;
          if (stat.isDirectory()) {
            const children = buildWikiTree(full, childPath);
            nodes.push({ name: entry, type: 'dir', path: childPath, children });
          } else if (entry.endsWith('.md')) {
            try {
              const page = readWikiPage(full);
              const cat = (page.frontmatter['type'] as string)
                ?? (page.frontmatter['category'] as string)
                ?? 'page';
              nodes.push({ name: entry, type: 'wiki', path: childPath, title: page.title, category: cat });
            } catch {
              nodes.push({ name: entry, type: 'wiki', path: childPath, title: entry.replace('.md', '') });
            }
          }
        }
        return nodes;
      }

      function buildRawTree(dir: string, relPath: string): TreeNode[] {
        const nodes: TreeNode[] = [];
        if (!existsSync(dir)) return nodes;
        const entries = readdirSync(dir).sort();
        for (const entry of entries) {
          if (entry.startsWith('.') || entry.endsWith('.meta.json')) continue;
          const full = join(dir, entry);
          const stat = statSync(full);
          const childPath = relPath ? `${relPath}/${entry}` : entry;
          if (stat.isDirectory()) {
            nodes.push({ name: entry, type: 'dir', path: childPath, children: buildRawTree(full, childPath) });
          } else {
            nodes.push({ name: entry, type: 'raw', path: childPath, size: stat.size });
          }
        }
        return nodes;
      }

      res.json({
        wiki: buildWikiTree(config.wikiDir, ''),
        raw: buildRawTree(config.rawDir, ''),
      });
    } catch {
      res.status(500).json({ error: 'Failed to build file tree' });
    }
  });

  // API: read config (for settings page)
  app.get('/api/config', async (_req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const safeConfig = { ...userConfig };
      if (safeConfig.api_key) safeConfig.api_key = safeConfig.api_key.slice(0, 8) + '…';
      const sc = safeConfig as Record<string, unknown>;
      if (sc['gemini_api_key']) {
        sc['gemini_api_key'] = String(sc['gemini_api_key']).slice(0, 8) + '…';
      }
      res.json(safeConfig);
    } catch {
      res.json({});
    }
  });

  // API: update config (for settings page)
  app.put('/api/config', async (req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const YAML = await import('yaml');
      const updates = req.body as Record<string, unknown>;
      const current = loadConfig(config.configPath);
      const merged = { ...current, ...updates };
      writeFileSync(config.configPath, YAML.stringify(merged), 'utf-8');
      res.json({ status: 'saved' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to save config: ${msg}` });
    }
  });

  // API: test provider connection
  app.post('/api/config/test-provider', async (req, res) => {
    try {
      const { provider: providerName, apiKey } = req.body as { provider?: string; apiKey?: string };
      if (!apiKey) { res.status(400).json({ error: 'Missing apiKey' }); return; }
      if (providerName === 'claude' || !providerName) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        await client.messages.create({
          model: 'claude-3-haiku-20240307',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        });
        res.json({ status: 'ok', provider: 'claude' });
      } else {
        res.json({ status: 'ok', provider: providerName, note: 'Skipped validation' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ status: 'error', error: msg });
    }
  });

  // API: search pages
  app.get('/api/search', (req, res) => {
    try {
      const q = (req.query['q'] as string ?? '').toLowerCase().trim();
      if (!q) { res.json([]); return; }
      const pages = listPages(config);
      const results = pages
        .filter(p => p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
        .slice(0, 20)
        .map(p => ({ title: p.title, category: p.category, wordCount: p.wordCount }));
      res.json(results);
    } catch {
      res.json([]);
    }
  });

  // API: wiki history (audit trail)
  app.get('/api/history', async (_req, res) => {
    try {
      const { listSnapshots } = await import('../core/history.js');
      const entries = listSnapshots(config);
      res.json(entries);
    } catch {
      res.json([]);
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

  // === GIT API ENDPOINTS ===

  // API: git status (lightweight by default, add ?full=true for file list)
  app.get('/api/git/status', async (req, res) => {
    try {
      const { isGitRepo, getGitStatus, getBranches } = await import('../core/git.js');
      const isRepo = await isGitRepo(config.root);
      if (!isRepo) {
        res.json({ initialized: false });
        return;
      }
      const includeFull = req.query['full'] === 'true';
      const status = await getGitStatus(config.root);
      const branches = await getBranches(config.root);
      const result: Record<string, unknown> = {
        initialized: true,
        branch: branches.current,
        branches: branches.all,
        isDetached: branches.isDetached,
        changedCount: status?.files?.length ?? 0,
        isClean: status?.isClean() ?? true,
      };
      if (includeFull) {
        result['files'] = status?.files ?? [];
      }
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Git status failed: ${msg}` });
    }
  });

  // API: initialize git repo
  app.post('/api/git/init', async (_req, res) => {
    try {
      const { initGitRepo } = await import('../core/git.js');
      const result = await initGitRepo(config);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Git init failed: ${msg}` });
    }
  });

  // API: git log (audit trail) with optional wiki-only filtering
  app.get('/api/git/log', async (req, res) => {
    try {
      const { getGitLog, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) {
        res.json([]);
        return;
      }
      const limit = parseInt(req.query['limit'] as string) || 50;
      const wikiOnly = req.query['wikiOnly'] !== 'false';
      const search = (req.query['search'] as string) || undefined;
      const log = await getGitLog(config.root, limit, { wikiOnly, search });
      res.json(log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Git log failed: ${msg}` });
    }
  });

  // API: git diff for a specific commit
  app.get('/api/git/diff/:hash', async (req, res) => {
    try {
      const hash = req.params['hash'];
      if (!hash) { res.status(400).json({ error: 'Missing hash' }); return; }
      const { getGitDiff, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) {
        res.json({ diff: '', stats: [] });
        return;
      }
      const result = await getGitDiff(config.root, hash);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Git diff failed: ${msg}` });
    }
  });

  // API: create branch (optionally from a specific commit hash)
  app.post('/api/git/branch', async (req, res) => {
    try {
      const { name, fromHash } = req.body as { name?: string; fromHash?: string };
      if (!name) { res.status(400).json({ error: 'Missing branch name' }); return; }
      const { createBranch } = await import('../core/git.js');
      const result = await createBranch(config.root, name, fromHash);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Create branch failed: ${msg}` });
    }
  });

  // API: switch branch
  app.post('/api/git/checkout', async (req, res) => {
    try {
      const { branch } = req.body as { branch?: string };
      if (!branch) { res.status(400).json({ error: 'Missing branch name' }); return; }
      const { switchBranch } = await import('../core/git.js');
      const result = await switchBranch(config.root, branch);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Checkout failed: ${msg}` });
    }
  });

  // API: create tag (milestone)
  app.post('/api/git/tag', async (req, res) => {
    try {
      const { name, message: tagMsg } = req.body as { name?: string; message?: string };
      if (!name) { res.status(400).json({ error: 'Missing tag name' }); return; }
      const { createTag } = await import('../core/git.js');
      const result = await createTag(config.root, name, tagMsg);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Create tag failed: ${msg}` });
    }
  });

  // API: restore to a specific commit
  app.post('/api/git/restore', async (req, res) => {
    try {
      const { hash } = req.body as { hash?: string };
      if (!hash) { res.status(400).json({ error: 'Missing commit hash' }); return; }
      const { restoreToCommit } = await import('../core/git.js');
      const result = await restoreToCommit(config.root, hash);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Restore failed: ${msg}` });
    }
  });

  // API: get file tree at a specific commit (for time-lapse)
  app.get('/api/git/tree/:hash', async (req, res) => {
    try {
      const hash = req.params['hash'];
      if (!hash) { res.status(400).json({ error: 'Missing hash' }); return; }
      const { getTreeAtCommit, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) { res.json([]); return; }
      const tree = await getTreeAtCommit(config.root, hash);
      res.json(tree);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Get tree failed: ${msg}` });
    }
  });

  // API: batch fetch file trees for multiple commits (time-lapse pre-fetch)
  app.post('/api/git/trees/batch', async (req, res) => {
    try {
      const { hashes } = req.body as { hashes?: string[] };
      if (!hashes || !Array.isArray(hashes) || hashes.length === 0) {
        res.status(400).json({ error: 'Missing or empty hashes array' });
        return;
      }
      const capped = hashes.slice(0, 500);
      const { getTreeAtCommit, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) {
        res.json({});
        return;
      }
      const result: Record<string, string[]> = {};
      const concurrency = 10;
      for (let i = 0; i < capped.length; i += concurrency) {
        const batch = capped.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (hash) => {
            try { result[hash] = await getTreeAtCommit(config.root, hash); }
            catch { result[hash] = []; }
          }),
        );
      }
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Batch tree fetch failed: ${msg}` });
    }
  });

  // API: graph data at a specific commit (for time-lapse graph animation)
  app.get('/api/git/graph/:hash', async (req, res) => {
    try {
      const hash = req.params['hash'];
      if (!hash) { res.status(400).json({ error: 'Missing hash' }); return; }
      const { getGraphAtCommit, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) { res.json({ nodes: [], links: [] }); return; }
      const graph = await getGraphAtCommit(config.root, hash);
      res.json(graph);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Get graph at commit failed: ${msg}` });
    }
  });

  // API: batch graph snapshots for time-lapse (pre-fetch all commit graphs)
  app.post('/api/git/graph-batch', async (req, res) => {
    try {
      const { hashes } = req.body as { hashes?: string[] };
      if (!hashes?.length) { res.status(400).json({ error: 'Missing hashes array' }); return; }
      const { getGraphAtCommit, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) { res.json({}); return; }
      const results: Record<string, unknown> = {};
      for (const hash of hashes.slice(0, 100)) {
        results[hash] = await getGraphAtCommit(config.root, hash);
      }
      res.json(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Batch graph failed: ${msg}` });
    }
  });

  // === RAW FILE PREVIEW ENDPOINTS ===

  // API: serve raw file with correct content-type (for PDF, images, video, audio)
  app.get('/api/raw/file/{*filePath}', (req, res) => {
    try {
      const filePath = String(req.params['filePath'] ?? '');
      if (!filePath) { res.status(400).json({ error: 'Missing file path' }); return; }
      const decoded = decodeURIComponent(filePath);
      const fullPath = join(config.rawDir, decoded);
      const resolved = resolve(fullPath);
      if (!resolved.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const ext = extname(resolved).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xls': 'application/vnd.ms-excel',
        '.csv': 'text/csv',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };

      const mime = mimeTypes[ext] ?? 'application/octet-stream';
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mime);
      res.sendFile(resolved);
    } catch (err) {
      res.status(500).json({ error: 'Failed to serve file' });
    }
  });

  // API: raw file metadata (for preview header)
  app.get('/api/raw/meta/{*filePath}', (req, res) => {
    try {
      const filePath = String(req.params['filePath'] ?? '');
      if (!filePath) { res.status(400).json({ error: 'Missing file path' }); return; }
      const decoded = decodeURIComponent(filePath);
      const fullPath = join(config.rawDir, decoded);
      const resolved = resolve(fullPath);
      if (!resolved.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const stat = statSync(resolved);
      const ext = extname(resolved).toLowerCase();

      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
      const videoExts = ['.mp4', '.webm', '.mov'];
      const audioExts = ['.mp3', '.wav', '.ogg'];
      const pdfExts = ['.pdf'];
      const spreadsheetExts = ['.csv', '.xlsx', '.xls'];
      const textExts = ['.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.ts', '.js', '.py', '.go', '.rs', '.toml', '.ini', '.cfg', '.env', '.sh', '.bash', '.zsh'];

      let previewType: string;
      if (imageExts.includes(ext)) previewType = 'image';
      else if (videoExts.includes(ext)) previewType = 'video';
      else if (audioExts.includes(ext)) previewType = 'audio';
      else if (pdfExts.includes(ext)) previewType = 'pdf';
      else if (spreadsheetExts.includes(ext)) previewType = 'spreadsheet';
      else if (textExts.includes(ext)) previewType = 'text';
      else previewType = 'binary';

      // Find wiki pages that were generated from this raw file
      const linkedPages: Array<{ title: string; slug: string }> = [];
      try {
        const pages = listWikiPages(config.wikiDir);
        for (const pagePath of pages) {
          const page = readWikiPage(pagePath);
          const sources = page.frontmatter['sources'] as string[] | undefined;
          if (sources?.some(s => s.includes(decoded) || s.includes(basename(decoded)))) {
            linkedPages.push({
              title: page.title,
              slug: basename(pagePath, '.md'),
            });
          }
        }
      } catch { /* non-fatal */ }

      res.json({
        name: basename(decoded),
        path: decoded,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
        extension: ext,
        previewType,
        linkedWikiPages: linkedPages,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get file metadata' });
    }
  });

  // Pipeline SSE endpoint — real-time step updates
  app.get('/api/pipeline/events', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');

    const onStep = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    import('../core/pipeline-events.js').then(({ pipelineEvents }) => {
      pipelineEvents.on('step', onStep);
      _req.on('close', () => pipelineEvents.off('step', onStep));
    });
  });

  // Pipeline runs history
  app.get('/api/pipeline/runs', async (_req, res) => {
    try {
      const { pipelineEvents } = await import('../core/pipeline-events.js');
      const runs = pipelineEvents.getRecentRuns();
      const summaries = runs.map(r => ({
        id: r.id,
        source: r.source,
        startedAt: r.startedAt,
        eventCount: r.events.length,
        hasSummary: !!r.summary,
        hasLLMTrace: !!r.llmTrace,
        result: r.result,
      }));
      res.json({ runs: summaries });
    } catch {
      res.json({ runs: [] });
    }
  });

  // Pipeline run detail (with LLM trace and summary)
  app.get('/api/pipeline/runs/:id', async (req, res) => {
    try {
      const { pipelineEvents } = await import('../core/pipeline-events.js');
      const runs = pipelineEvents.getRecentRuns();
      const run = runs.find(r => r.id === req.params['id']);
      if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
      res.json(run);
    } catch {
      res.status(500).json({ error: 'Failed to get run' });
    }
  });

  // ─── Connector APIs ───────────────────────────────────────────────────────

  // GET /api/connectors — list all configured connectors
  app.get('/api/connectors', async (_req, res) => {
    try {
      const { getConnectorManager } = await import('../core/connectors.js');
      const mgr = getConnectorManager(vaultRoot);
      const connectors = mgr.getAll().map(c => ({
        ...c,
        exists: existsSync(c.path),
      }));
      res.json({ connectors });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/connectors — add a new connector
  app.post('/api/connectors', async (req, res) => {
    try {
      const { getConnectorManager } = await import('../core/connectors.js');
      const mgr = getConnectorManager(vaultRoot);
      const body = req.body as {
        type: 'folder' | 'git-repo' | 'github';
        name?: string;
        path?: string;
        url?: string;
        includeGlobs?: string[];
        excludeGlobs?: string[];
        autoSync?: boolean;
      };

      if (!body.type) { res.status(400).json({ error: 'Missing type' }); return; }

      let resolvedPath = body.path || '';

      // For git repos, clone if URL provided
      if (body.type === 'github' || (body.type === 'git-repo' && body.url)) {
        const reposDir = join(vaultRoot, '.wikimem-repos');
        mkdirSync(reposDir, { recursive: true });
        const repoName = (body.url ?? '').split('/').pop()?.replace('.git', '') || 'repo';
        resolvedPath = join(reposDir, repoName);
        if (!existsSync(resolvedPath)) {
          const result = await mgr.cloneRepo(body.url!, resolvedPath);
          if (!result.success) {
            res.status(500).json({ error: result.error });
            return;
          }
        }
      }

      if (!resolvedPath || !existsSync(resolvedPath)) {
        res.status(400).json({ error: `Path does not exist: ${resolvedPath}` });
        return;
      }

      const connector = mgr.add({
        type: body.type,
        name: body.name || basename(resolvedPath),
        path: resolvedPath,
        url: body.url,
        includeGlobs: body.includeGlobs,
        excludeGlobs: body.excludeGlobs,
        autoSync: body.autoSync ?? false,
      });

      if (connector.autoSync) mgr.startWatcher(connector);
      res.json({ connector });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/connectors/:id — remove a connector
  app.delete('/api/connectors/:id', async (req, res) => {
    try {
      const { getConnectorManager } = await import('../core/connectors.js');
      const mgr = getConnectorManager(vaultRoot);
      const removed = mgr.remove(req.params['id']!);
      res.json({ removed });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/connectors/:id/sync — manually trigger a sync (scan + ingest all files)
  app.post('/api/connectors/:id/sync', async (req, res) => {
    try {
      const { getConnectorManager } = await import('../core/connectors.js');
      const { ingestSource } = await import('../core/ingest.js');
      const mgr = getConnectorManager(vaultRoot);
      const connector = mgr.get(req.params['id']!);
      if (!connector) { res.status(404).json({ error: 'Connector not found' }); return; }

      mgr.updateStatus(connector.id, 'syncing');
      const startMs = Date.now();
      const files = await mgr.scanFiles(connector);
      let pagesCreated = 0, linksAdded = 0, ingested = 0;
      const errors: string[] = [];

      const { createProvider } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProvider(userConfig.provider ?? 'claude');

      for (const filePath of files.slice(0, 50)) { // cap at 50 per sync
        try {
          const result = await ingestSource(filePath, config, provider, { verbose: false });
          pagesCreated += result.pagesUpdated ?? 0;
          linksAdded += result.linksAdded ?? 0;
          ingested++;
        } catch (e) {
          errors.push(`${basename(filePath)}: ${String(e).substring(0, 100)}`);
        }
      }

      mgr.updateStatus(connector.id, 'active', {
        lastSyncAt: new Date().toISOString(),
        totalFiles: files.length,
      });

      const result = {
        connectorId: connector.id,
        filesFound: files.length,
        filesIngested: ingested,
        pagesCreated,
        linksAdded,
        errors,
        duration: Date.now() - startMs,
      };
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/connectors/:id/scan — scan files in connector (no ingest)
  app.get('/api/connectors/:id/scan', async (req, res) => {
    try {
      const { getConnectorManager } = await import('../core/connectors.js');
      const mgr = getConnectorManager(vaultRoot);
      const connector = mgr.get(req.params['id']!);
      if (!connector) { res.status(404).json({ error: 'Not found' }); return; }
      const files = await mgr.scanFiles(connector);
      res.json({ files: files.slice(0, 200), total: files.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Wire file-detected events from connectors to auto-ingest
  (async () => {
    const { getConnectorManager } = await import('../core/connectors.js');
    const { ingestSource } = await import('../core/ingest.js');
    const { createProvider } = await import('../providers/index.js');
    const { loadConfig } = await import('../core/config.js');
    const mgr = getConnectorManager(vaultRoot);
    mgr.on('file-detected', async ({ connectorId, filePath }: { connectorId: string; filePath: string }) => {
      const connector = mgr.get(connectorId);
      if (!connector) return;
      mgr.updateStatus(connectorId, 'syncing');
      try {
        const userConfig = loadConfig(config.configPath);
        const provider = createProvider(userConfig.provider ?? 'claude');
        await ingestSource(filePath, config, provider, { verbose: false });
        mgr.updateStatus(connectorId, 'active', { lastSyncAt: new Date().toISOString() });
      } catch {
        mgr.updateStatus(connectorId, 'error', { errorMessage: `Failed to ingest ${basename(filePath)}` });
      }
    });
    mgr.startAllWatchers();
  })().catch(() => {});

  // AUTO-005: Watch raw/ directory for new files, auto-trigger ingest
  (async () => {
    try {
      const chokidar = await import('chokidar');
      const { ingestSource } = await import('../core/ingest.js');
      const { createProvider } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const rawDir = config.rawDir;
      if (!existsSync(rawDir)) return;

      const watcher = chokidar.watch(rawDir, {
        ignored: ['**/.git/**', '**/*.tmp'],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 1500 },
      });

      watcher.on('add', async (filePath: string) => {
        const INGESTIBLE = new Set(['.md', '.txt', '.pdf', '.json', '.yaml', '.yml', '.csv', '.html', '.docx', '.mp3', '.wav', '.m4a', '.mp4', '.mov']);
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        if (!INGESTIBLE.has('.' + ext)) return;
        console.log(`[watcher] New file detected: ${filePath}`);
        try {
          const userConfig = loadConfig(config.configPath);
          const provider = createProvider(userConfig.provider ?? 'claude');
          await ingestSource(filePath, config, provider, { verbose: false });
          console.log(`[watcher] Ingested: ${filePath}`);
        } catch (err) {
          console.error(`[watcher] Failed to ingest ${filePath}:`, err);
        }
      });

      console.log(`  Auto-watching raw/ for new files: ${rawDir}`);
    } catch {}
  })().catch(() => {});

  // Serve static files AFTER all API routes
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

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
