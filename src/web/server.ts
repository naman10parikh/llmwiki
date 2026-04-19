import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync as fsUnlinkSync, chmodSync } from 'node:fs';
import { join, resolve, extname, basename, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { getVaultConfig, getVaultStats, ensureVaultDirs, listWikiPages, readWikiPage, writeWikiPage, readPageVersions } from '../core/vault.js';
import type { VaultConfig } from '../core/vault.js';
import { getBundledCredentials, getBundledDeviceFlowClientId, hasBundledDefaults } from '../core/oauth-defaults.js';
import type { UserConfig } from '../core/config.js';
import { isPrivacyAccepted, markPrivacyAccepted, deleteAllVaultData, ensureVaultGitignore } from '../core/privacy.js';
import { registerOAuthRoutes } from '../mcp/oauth-server.js';
import { registerMcpHttpRoutes } from '../mcp/http-server.js';

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

// In-memory cache for /api/graph — invalidated when wiki dir mtime changes
let graphCache: { data: GraphData; mtime: number } | null = null;

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
  tags: string[];
  mtime?: string;
}

function listPages(config: VaultConfig): PageInfo[] {
  const pages = listWikiPages(config.wikiDir);
  return pages.map((p) => {
    const page = readWikiPage(p);
    let mtime: string | undefined;
    try { mtime = statSync(p).mtime.toISOString(); } catch { /* ignore */ }
    return {
      title: page.title,
      path: p,
      wordCount: page.wordCount,
      category: (page.frontmatter['category'] as string) ?? 'uncategorized',
      wikilinks: page.wikilinks,
      tags: (page.frontmatter['tags'] as string[] | undefined) ?? [],
      mtime,
    };
  });
}

export function createServer(vaultRoot: string, port: number): void {
  const app = express();
  const config = getVaultConfig(vaultRoot);

  // Ensure vault directories exist before accepting any requests.
  // Without this, a fresh vault hits ENOENT on the first /api/status call.
  ensureVaultDirs(config);

  // Ensure .gitignore protects sensitive files on every server start
  ensureVaultGitignore(vaultRoot);

  // Load persisted pipeline runs so they survive server restarts
  import('../core/pipeline-events.js').then(({ pipelineEvents }) => {
    pipelineEvents.initPersistence(vaultRoot);
  }).catch(() => {});

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // MCP OAuth 2.1 + HTTP transport — makes wikimem a Claude-Connector-compatible
  // Authorization Server and exposes /mcp with Bearer auth. See src/mcp/*.
  registerOAuthRoutes(app, { vaultRoot, port });
  registerMcpHttpRoutes(app, { vaultRoot, port });

  const publicDir = join(__dirname, 'public');

  // API: vault status
  app.get('/api/status', (_req, res) => {
    try {
      const stats = getVaultStats(config);
      res.json(stats);
    } catch (err) {
      // Log the real error so it's visible in server output
      console.error('[/api/status] getVaultStats failed (attempt 1):', err);
      // Retry once — handles transient ENOENT from readFileSync racing readdirSync
      try {
        ensureVaultDirs(config);
        const stats = getVaultStats(config);
        res.json(stats);
      } catch (retryErr) {
        console.error('[/api/status] getVaultStats failed (attempt 2):', retryErr);
        res.status(500).json({ error: 'Failed to read vault status' });
      }
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
      if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        res.status(400).json({ error: 'Invalid slug — only alphanumeric, hyphens, and underscores allowed' });
        return;
      }
      const dest = join(config.wikiDir, `${slug}.md`);
      if (!resolve(dest).startsWith(resolve(config.wikiDir))) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }
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
      // UXO-039: normalize metadata field names for consistent front-end display
      const fm = page.frontmatter as Record<string, unknown>;
      if ('createdAt' in fm && !('created' in fm)) { fm['created'] = fm['createdAt']; delete fm['createdAt']; }
      if ('created_at' in fm && !('created' in fm)) { fm['created'] = fm['created_at']; delete fm['created_at']; }
      if ('type' in fm && !('category' in fm)) { fm['category'] = fm['type']; delete fm['type']; }
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

  // API: get page version history (COMP-MP-002 temporal reasoning)
  app.get('/api/pages/:title/versions', (req, res) => {
    try {
      const title = req.params['title'];
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const versions = readPageVersions(config.root, slug);
      // Also include current page as the "latest" entry
      const pages = listWikiPages(config.wikiDir);
      const titleLower = title.toLowerCase();
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === slug) return true;
        try { return readWikiPage(p).title.toLowerCase() === titleLower; } catch { return false; }
      });
      let current = null;
      if (match) {
        try {
          const page = readWikiPage(match);
          current = {
            version: (page.frontmatter['fact_version'] as number) ?? versions.length + 1,
            timestamp: (page.frontmatter['learned_at'] as string) ?? (page.frontmatter['updated'] as string) ?? new Date().toISOString(),
            content: page.content,
            frontmatter: page.frontmatter,
            source: (page.frontmatter['sources'] as string[])?.[0],
            actor: (page.frontmatter['added_by'] as string) ?? 'unknown',
          };
        } catch { /* unreadable */ }
      }
      res.json({ versions, current, total: versions.length + (current ? 1 : 0) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read page versions' });
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

  // API: delete a wiki page
  app.delete('/api/pages/:title', async (req, res) => {
    try {
      const title = req.params['title'];
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }

      const pages = listWikiPages(config.wikiDir);
      const titleLower = title.toLowerCase();
      const slugified = titleLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === title || fileSlug === slugified) return true;
        try { return readWikiPage(p).title.toLowerCase() === titleLower; } catch { return false; }
      });
      if (!match) { res.status(404).json({ error: 'Page not found' }); return; }

      const { unlinkSync } = await import('node:fs');
      unlinkSync(match);

      try {
        const { autoCommit } = await import('../core/git.js');
        await autoCommit(config.root, 'manual', `delete page "${title}"`);
      } catch {}

      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to delete: ${msg}` });
    }
  });

  // API: update validation status / confidence on a wiki page
  app.patch('/api/pages/:title/validate', async (req, res) => {
    try {
      const title = req.params['title'];
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }
      const { validation_status, confidence } = req.body as {
        validation_status?: string;
        confidence?: number;
      };
      const allowed = ['verified', 'outdated', 'wrong', 'unreviewed'];
      if (validation_status && !allowed.includes(validation_status)) {
        res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
        return;
      }

      const pages = listWikiPages(config.wikiDir);
      const titleLower = title.toLowerCase();
      const slugified = titleLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === title || fileSlug === slugified) return true;
        try { return readWikiPage(p).title.toLowerCase() === titleLower; } catch { return false; }
      });
      if (!match) { res.status(404).json({ error: 'Page not found' }); return; }

      const matter = await import('gray-matter');
      const raw = readFileSync(match, 'utf-8');
      const parsed = matter.default(raw);

      if (validation_status) parsed.data['validation_status'] = validation_status;
      if (confidence !== undefined) parsed.data['confidence'] = Math.max(0, Math.min(100, confidence));
      parsed.data['validated_at'] = new Date().toISOString().split('T')[0];

      // Adjust confidence based on validation feedback
      if (validation_status === 'verified') {
        parsed.data['confidence'] = Math.max(parsed.data['confidence'] ?? 50, 85);
      } else if (validation_status === 'outdated') {
        parsed.data['confidence'] = Math.min(parsed.data['confidence'] ?? 50, 40);
      } else if (validation_status === 'wrong') {
        parsed.data['confidence'] = Math.min(parsed.data['confidence'] ?? 50, 15);
      }

      writeFileSync(match, matter.default.stringify(parsed.content, parsed.data), 'utf-8');

      try {
        const { autoCommit } = await import('../core/git.js');
        await autoCommit(config.root, 'manual', `validate page "${title}" as ${validation_status ?? 'updated'}`);
      } catch { /* git commit is best-effort */ }

      const page = readWikiPage(match);
      res.json({ status: 'updated', page });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to validate: ${msg}` });
    }
  });

  // API: rename a wiki page
  app.post('/api/pages/:title/rename', async (req, res) => {
    try {
      const oldTitle = req.params['title'];
      const { newTitle } = req.body as { newTitle?: string };
      if (!oldTitle || !newTitle) { res.status(400).json({ error: 'Missing title' }); return; }

      const pages = listWikiPages(config.wikiDir);
      const titleLower = oldTitle.toLowerCase();
      const slugified = titleLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === oldTitle || fileSlug === slugified) return true;
        try { return readWikiPage(p).title.toLowerCase() === titleLower; } catch { return false; }
      });
      if (!match) { res.status(404).json({ error: 'Page not found' }); return; }

      const content = readFileSync(match, 'utf-8');
      const newContent = content.replace(/^title:\s*["']?.*?["']?\s*$/m, `title: "${newTitle}"`);
      const newSlug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!newSlug) { res.status(400).json({ error: 'Invalid title — produces empty slug' }); return; }
      const newPath = join(match.substring(0, match.lastIndexOf('/')), newSlug + '.md');
      if (!resolve(newPath).startsWith(resolve(config.wikiDir))) { res.status(403).json({ error: 'Path traversal denied' }); return; }

      writeFileSync(newPath, newContent, 'utf-8');
      if (newPath !== match) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(match);
      }

      try {
        const { autoCommit } = await import('../core/git.js');
        await autoCommit(config.root, 'manual', `rename "${oldTitle}" → "${newTitle}"`);
      } catch {}

      res.json({ status: 'renamed', newTitle, newSlug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to rename: ${msg}` });
    }
  });

  // API: knowledge graph data (cached, invalidated by wiki dir mtime)
  app.get('/api/graph', (_req, res) => {
    try {
      const dirMtime = statSync(config.wikiDir).mtimeMs;
      if (!graphCache || graphCache.mtime < dirMtime) {
        graphCache = { data: buildGraph(config), mtime: dirMtime };
      }
      res.json(graphCache.data);
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
          const { createProviderFromUserConfig } = await import('../providers/index.js');
          const { loadConfig } = await import('../core/config.js');
          const userConfig = loadConfig(config.configPath);
          const provider = createProviderFromUserConfig(userConfig);
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
        mtime?: string;
        isDateDir?: boolean;
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

      const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

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
            const isDateDir = !relPath && DATE_DIR_RE.test(entry);
            nodes.push({
              name: entry,
              type: 'dir',
              path: childPath,
              children: buildRawTree(full, childPath),
              mtime: stat.mtime.toISOString(),
              isDateDir,
            });
          } else {
            nodes.push({ name: entry, type: 'raw', path: childPath, size: stat.size, mtime: stat.mtime.toISOString() });
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
      const safeConfig = { name: 'My Wiki', ...userConfig } as Record<string, unknown>;
      if (safeConfig['api_key']) safeConfig['api_key'] = String(safeConfig['api_key']).slice(0, 8) + '…';
      if (safeConfig['gemini_api_key']) {
        safeConfig['gemini_api_key'] = String(safeConfig['gemini_api_key']).slice(0, 8) + '…';
      }
      res.json(safeConfig);
    } catch {
      res.json({ name: 'My Wiki' });
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
      if (providerName === 'claude-code') {
        const { isClaudeCodeAvailable } = await import('../core/claude-code.js');
        if (isClaudeCodeAvailable()) {
          res.json({ status: 'ok', provider: 'claude-code' });
        } else {
          res.json({ status: 'error', error: 'Claude Code CLI not found in PATH' });
        }
        return;
      }
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

  // API: Claude Code CLI availability
  app.get('/api/claude-code/status', async (_req, res) => {
    try {
      const { isClaudeCodeAvailable, getClaudeCodePath } = await import('../core/claude-code.js');
      res.json({ available: isClaudeCodeAvailable(), path: getClaudeCodePath() });
    } catch {
      res.json({ available: false, path: null });
    }
  });

  // API: search pages (with filters: category, tag, dateFrom, dateTo)
  app.get('/api/search', (req, res) => {
    try {
      const q = (req.query['q'] as string ?? '').toLowerCase().trim();
      const limit = parseInt(req.query['limit'] as string) || 20;
      const filterCategory = (req.query['category'] as string ?? '').toLowerCase().trim();
      const filterTag = (req.query['tag'] as string ?? '').toLowerCase().trim();
      const filterDateFrom = (req.query['dateFrom'] as string ?? '').trim();
      const filterDateTo = (req.query['dateTo'] as string ?? '').trim();

      if (!q && !filterCategory && !filterTag) { res.json({ results: [] }); return; }

      const pages = listWikiPages(config.wikiDir);
      const results: Array<{ title: string; category: string; tags: string[]; created?: string; wordCount: number; snippet?: string; matchType: string }> = [];

      for (const pagePath of pages) {
        const page = readWikiPage(pagePath);
        const category = ((page.frontmatter['category'] ?? page.frontmatter['type'] ?? '') as string).toLowerCase();
        const tags = ((page.frontmatter['tags'] as string[]) ?? []).map((t: string) => t.toLowerCase());
        const created = (page.frontmatter['created'] ?? page.frontmatter['date'] ?? '') as string;

        // Apply filters
        if (filterCategory && category !== filterCategory) continue;
        if (filterTag && !tags.includes(filterTag)) continue;
        if (filterDateFrom && created && created < filterDateFrom) continue;
        if (filterDateTo && created && created > filterDateTo) continue;

        // If no text query, include all filtered pages
        if (!q) {
          results.push({ title: page.title, category: category || 'uncategorized', tags, created, wordCount: page.wordCount, matchType: 'filter' });
          if (results.length >= limit) break;
          continue;
        }

        // Text matching
        const titleMatch = page.title.toLowerCase().includes(q);
        const tagMatch = tags.some(t => t.includes(q));

        let snippet: string | undefined;
        let contentMatch = false;
        const bodyLower = page.content.toLowerCase();
        const idx = bodyLower.indexOf(q);
        if (idx >= 0) {
          contentMatch = true;
          // Build snippet with highlighted match context
          const start = Math.max(0, idx - 50);
          const end = Math.min(page.content.length, idx + q.length + 80);
          const raw = page.content.substring(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' ');
          // Wrap the matched term in <mark> for highlighting
          const matchStart = idx - start;
          const before = raw.substring(0, matchStart);
          const match = raw.substring(matchStart, matchStart + q.length);
          const after = raw.substring(matchStart + q.length);
          snippet = (start > 0 ? '…' : '') + before + '<mark>' + match + '</mark>' + after + (end < page.content.length ? '…' : '');
        }

        if (titleMatch || tagMatch || contentMatch) {
          const matchType = titleMatch ? 'title' : tagMatch ? 'tag' : 'content';
          results.push({ title: page.title, category: category || 'uncategorized', tags, created, wordCount: page.wordCount, snippet, matchType });
        }
        if (results.length >= limit) break;
      }

      // Also return available filter options for the UI
      const allCategories = [...new Set(pages.map(p => {
        const pg = readWikiPage(p);
        return ((pg.frontmatter['category'] ?? pg.frontmatter['type'] ?? '') as string).toLowerCase();
      }).filter(Boolean))].sort();

      const allTags = [...new Set(pages.flatMap(p => {
        const pg = readWikiPage(p);
        return ((pg.frontmatter['tags'] as string[]) ?? []).map((t: string) => t.toLowerCase());
      }))].sort();

      res.json({ results, filters: { categories: allCategories, tags: allTags } });
    } catch {
      res.json({ results: [] });
    }
  });

  // Utility: extract keywords from text (lowercase, deduplicated, stopwords removed)
  function extractKeywords(text: string): Set<string> {
    const stopwords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','can','shall','and','or','but','if','in','on','at','to','for','of','with','by','from','as','into','about','that','this','it','its','not','no','so','up','out','then','than','more','also','very','just','only','each','any','all','both','few','many','some','such','too','own','same','other','most','much','what','when','where','which','who','how']);
    return new Set(
      text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.has(w))
    );
  }

  // Utility: Jaccard similarity between two sets
  function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) { if (b.has(item)) intersection++; }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // API: similar pages (Jaccard similarity on tags + wikilinks + title keywords)
  app.get('/api/pages/:title/similar', (req, res) => {
    try {
      const targetTitle = decodeURIComponent(req.params['title'] ?? '');
      const limit = parseInt(req.query['limit'] as string) || 5;
      const pages = listWikiPages(config.wikiDir);

      // Find target page
      let targetPage: ReturnType<typeof readWikiPage> | null = null;
      const allPages: Array<ReturnType<typeof readWikiPage>> = [];

      for (const p of pages) {
        const page = readWikiPage(p);
        allPages.push(page);
        if (page.title.toLowerCase() === targetTitle.toLowerCase()) {
          targetPage = page;
        }
      }

      if (!targetPage) {
        res.json({ similar: [] });
        return;
      }

      // Build feature sets for target
      const targetTags = new Set((targetPage.frontmatter['tags'] as string[] ?? []).map((t: string) => t.toLowerCase()));
      const targetLinks = new Set((targetPage.wikilinks ?? []).map((l: string) => l.toLowerCase()));
      const targetWords = extractKeywords(targetPage.title + ' ' + targetPage.content);
      const targetCategory = ((targetPage.frontmatter['category'] ?? targetPage.frontmatter['type'] ?? '') as string).toLowerCase();

      // Score each other page
      const scored: Array<{ title: string; category: string; score: number; sharedTags: string[]; sharedLinks: string[] }> = [];

      for (const page of allPages) {
        if (page.title.toLowerCase() === targetTitle.toLowerCase()) continue;

        const pageTags = new Set((page.frontmatter['tags'] as string[] ?? []).map((t: string) => t.toLowerCase()));
        const pageLinks = new Set((page.wikilinks ?? []).map((l: string) => l.toLowerCase()));
        const pageWords = extractKeywords(page.title + ' ' + page.content);
        const pageCategory = ((page.frontmatter['category'] ?? page.frontmatter['type'] ?? '') as string).toLowerCase();

        // Jaccard similarity components (weighted)
        const tagSim = jaccardSimilarity(targetTags, pageTags);
        const linkSim = jaccardSimilarity(targetLinks, pageLinks);
        const wordSim = jaccardSimilarity(targetWords, pageWords);
        const catBonus = targetCategory && targetCategory === pageCategory ? 0.15 : 0;

        // Weighted composite: tags 40%, links 30%, keywords 20%, category 10%
        const score = (tagSim * 0.4) + (linkSim * 0.3) + (wordSim * 0.2) + catBonus;

        if (score > 0.02) {
          const sharedTags = [...targetTags].filter(t => pageTags.has(t));
          const sharedLinks = [...targetLinks].filter(l => pageLinks.has(l));
          const category = (page.frontmatter['category'] as string) ?? (page.frontmatter['type'] as string) ?? 'uncategorized';
          scored.push({ title: page.title, category, score: Math.round(score * 100) / 100, sharedTags, sharedLinks });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      res.json({ similar: scored.slice(0, limit) });
    } catch {
      res.json({ similar: [] });
    }
  });

  // API: page excerpt (for hover previews on wikilinks)
  app.get('/api/pages/:title/excerpt', (req, res) => {
    try {
      const targetTitle = decodeURIComponent(req.params['title'] ?? '');
      if (!targetTitle) {
        res.status(400).json({ error: 'Missing title' });
        return;
      }

      const pages = listWikiPages(config.wikiDir);
      const titleLower = targetTitle.toLowerCase();
      const slugified = titleLower
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === targetTitle || fileSlug === slugified) return true;
        try {
          const page = readWikiPage(p);
          return page.title.toLowerCase() === titleLower;
        } catch {
          return false;
        }
      });

      if (!match) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      const page = readWikiPage(match);
      const category =
        (page.frontmatter['category'] as string) ??
        (page.frontmatter['type'] as string) ??
        'uncategorized';
      const tags =
        (page.frontmatter['tags'] as string[] | undefined) ?? [];

      // Strip frontmatter and markup for clean excerpt
      const rawBody = (page.content ?? '')
        .replace(/^---[\s\S]*?---\s*/m, '')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/#{1,6}\s*/g, '')
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
        .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
        .replace(/\n+/g, ' ')
        .trim();

      res.json({
        title: page.title,
        category,
        tags,
        excerpt: rawBody.slice(0, 160),
        wordCount: page.wordCount,
      });
    } catch {
      res.status(500).json({ error: 'Failed to get excerpt' });
    }
  });

  // API: backlinks with context snippets + related-by-tags
  app.get('/api/backlinks/:title/context', (req, res) => {
    try {
      const targetTitle = decodeURIComponent(req.params['title'] ?? '');
      if (!targetTitle) {
        res.status(400).json({ error: 'Missing title' });
        return;
      }

      const pages = listWikiPages(config.wikiDir);
      const titleLower = targetTitle.toLowerCase();

      interface FullPageInfo {
        title: string;
        category: string;
        tags: string[];
        wikilinks: string[];
        rawContent: string;
      }
      const allLoaded: FullPageInfo[] = [];
      let targetTags: string[] = [];

      for (const p of pages) {
        try {
          const page = readWikiPage(p);
          const tags =
            (page.frontmatter['tags'] as string[] | undefined) ?? [];
          const category =
            (page.frontmatter['category'] as string) ??
            (page.frontmatter['type'] as string) ??
            'uncategorized';
          const rawContent = (page.content ?? '').replace(
            /^---[\s\S]*?---\s*/m,
            '',
          );
          allLoaded.push({
            title: page.title,
            category,
            tags,
            wikilinks: page.wikilinks,
            rawContent,
          });
          if (page.title.toLowerCase() === titleLower) {
            targetTags = tags;
          }
        } catch {
          /* skip unreadable */
        }
      }

      // Backlinks with context snippets
      interface BacklinkContext {
        title: string;
        category: string;
        snippet: string;
      }
      const backlinkContexts: BacklinkContext[] = [];

      for (const p of allLoaded) {
        if (p.title.toLowerCase() === titleLower) continue;
        const linked = p.wikilinks.some(
          (l) => l.toLowerCase() === titleLower,
        );
        if (!linked) continue;

        // Grab context around the [[TargetTitle]] mention
        const escaped = targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wikilinkPattern = new RegExp(
          `(.{0,80})\\[\\[${escaped}\\]\\](.{0,80})`,
          'i',
        );
        const m = wikilinkPattern.exec(p.rawContent);
        let snippet = '';
        if (m) {
          const before = (m[1] ?? '').replace(/\n/g, ' ').trimStart();
          const after = (m[2] ?? '').replace(/\n/g, ' ').trimEnd();
          snippet = `...${before}${targetTitle}${after}...`.trim();
        }
        backlinkContexts.push({
          title: p.title,
          category: p.category,
          snippet,
        });
      }

      // Related by tags (share ≥2 tags)
      interface RelatedByTag {
        title: string;
        category: string;
        sharedTags: string[];
      }
      const relatedByTags: RelatedByTag[] = [];
      if (targetTags.length >= 1) {
        const targetTagsLower = targetTags.map((t) => t.toLowerCase());
        for (const p of allLoaded) {
          if (p.title.toLowerCase() === titleLower) continue;
          const shared = p.tags.filter((t) =>
            targetTagsLower.includes(t.toLowerCase()),
          );
          if (shared.length >= 2) {
            relatedByTags.push({
              title: p.title,
              category: p.category,
              sharedTags: shared,
            });
          }
        }
        relatedByTags.sort((a, b) => b.sharedTags.length - a.sharedTags.length);
      }

      res.json({
        backlinks: backlinkContexts,
        relatedByTags: relatedByTags.slice(0, 8),
      });
    } catch {
      res.status(500).json({ error: 'Failed to get backlink context' });
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
      const { question, provider: providerName, model: modelName } = req.body as { question?: string; provider?: string; model?: string };
      if (!question) {
        res.status(400).json({ error: 'Missing question field' });
        return;
      }
      const { queryWiki } = await import('../core/query.js');
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig, {
        providerOverride: providerName,
        model: modelName,
      });
      const result = await queryWiki(question, config, provider, { fileBack: false });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Query failed: ${msg}` });
    }
  });

  // API: query the wiki — streaming SSE endpoint
  app.post('/api/query-stream', async (req, res) => {
    const { question, provider: providerName, model: modelName } = req.body as { question?: string; provider?: string; model?: string };
    if (!question) {
      res.status(400).json({ error: 'Missing question field' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (obj: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    try {
      send({ type: 'phase', phase: 'searching', message: 'Searching knowledge base...' });

      const { loadConfig } = await import('../core/config.js');
      const { searchPages } = await import('../search/index.js');
      const { listWikiPages, readWikiPage } = await import('../core/vault.js');
      const { readFileSync, existsSync } = await import('node:fs');

      const userConfig: UserConfig = loadConfig(config.configPath);
      const allPages = listWikiPages(config.wikiDir);
      const relevantPages = await searchPages(question, allPages, {
        mode: 'bm25',
        wikiDir: config.wikiDir,
      });

      const pageContents: string[] = [];
      const sourcesConsulted: string[] = [];
      for (const pagePath of relevantPages.slice(0, 10)) {
        try {
          const page = readWikiPage(pagePath);
          pageContents.push(`## ${page.title}\n${page.content}`);
          sourcesConsulted.push(page.title);
        } catch { /* skip */ }
      }

      send({ type: 'phase', phase: 'analyzing', message: `Analyzing ${sourcesConsulted.length} pages...` });
      send({ type: 'sources', sources: sourcesConsulted });

      const indexContent = existsSync(config.indexPath) ? readFileSync(config.indexPath, 'utf-8') : '';
      const prompt = `# Query Against Wiki\n\n## Question\n${question}\n\n## Wiki Index\n${indexContent.substring(0, 3000)}\n\n## Relevant Pages\n${pageContents.join('\n\n---\n\n').substring(0, 20000)}\n\n## Instructions\nAnswer the question based on the wiki content above. Use [[wikilinks]] when referencing pages. Cite your sources inline using numbered references like [1], [2] etc., matching the order sources appear. If the wiki doesn't contain enough information, say so clearly.`;
      const systemPrompt = 'You are a knowledgeable wiki assistant. Answer questions by synthesizing information from the wiki pages provided. Always cite sources using [[wikilinks]] and inline numbered references [1], [2] etc. Be concise and accurate.';

      send({ type: 'phase', phase: 'composing', message: 'Composing answer...' });

      // Detect provider from model name
      const isOpenAI = modelName?.startsWith('gpt-') || providerName === 'openai';
      const isOllama = providerName === 'ollama';

      if (isOpenAI) {
        // OpenAI streaming
        const apiKey = userConfig.query_api_key ?? userConfig.api_key ?? process.env['OPENAI_API_KEY'];
        if (!apiKey) throw new Error('OpenAI API key not found. Add it in Settings.');
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey });
        const stream = await client.chat.completions.create({
          model: modelName ?? 'gpt-4o',
          max_tokens: 4096,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) send({ type: 'token', token: delta });
        }
      } else if (isOllama) {
        const baseUrl = userConfig.query_base_url ?? 'http://localhost:11434';
        const ollamaModel = modelName ?? userConfig.query_model ?? 'llama3';
        const ollamaRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            stream: true,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          }),
        });
        if (!ollamaRes.ok || !ollamaRes.body) throw new Error('Ollama request failed');
        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as { message?: { content?: string } };
              const token = parsed.message?.content;
              if (token) send({ type: 'token', token });
            } catch { /* skip */ }
          }
        }
      } else {
        // Claude streaming (default)
        const apiKey = userConfig.query_api_key ?? userConfig.api_key ?? process.env['ANTHROPIC_API_KEY'];
        if (!apiKey) throw new Error('Anthropic API key not found. Add it in Settings → AI Models.');
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        const stream = await client.messages.stream({
          model: modelName ?? 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            send({ type: 'token', token: event.delta.text });
          }
        }
      }

      send({ type: 'done', sources: sourcesConsulted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('rate limit');
      const isAuthError = msg.includes('401') || msg.toLowerCase().includes('authentication') || msg.toLowerCase().includes('api key');
      send({ type: 'error', message: msg, isRateLimit, isAuthError });
    } finally {
      res.end();
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
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);
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

  // API: list branches (dedicated endpoint)
  app.get('/api/git/branches', async (_req, res) => {
    try {
      const { getBranches, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) {
        res.json({ current: '', branches: [], isDetached: false });
        return;
      }
      const info = await getBranches(config.root);
      res.json({ current: info.current, branches: info.all, isDetached: info.isDetached });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list branches: ${msg}` });
    }
  });

  // API: create session branch (auto-naming with wiki/session-<timestamp> or custom name)
  app.post('/api/git/branches', async (req, res) => {
    try {
      const { name, session } = req.body as { name?: string; session?: boolean };
      const { createBranch } = await import('../core/git.js');
      let branchName = name;
      if (!branchName || session) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        branchName = name ? `wiki/${name}` : `wiki/session-${ts}`;
      }
      const result = await createBranch(config.root, branchName);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Create branch failed: ${msg}` });
    }
  });

  // API: push current branch to remote
  app.post('/api/git/push', async (req, res) => {
    try {
      const { remote } = req.body as { remote?: string };
      const { pushBranch } = await import('../core/git.js');
      const result = await pushBranch(config.root, remote || 'origin');
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Push failed: ${msg}` });
    }
  });

  // API: submit for review (PR workflow: diff summary, auto-branch, push)
  app.post('/api/git/pr', async (req, res) => {
    try {
      const { description } = req.body as { description?: string };
      const { submitForReview } = await import('../core/git.js');
      const result = await submitForReview(config.root, description);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Submit for review failed: ${msg}` });
    }
  });

  // API: get diff summary (working branch vs base)
  app.get('/api/git/diff-summary', async (req, res) => {
    try {
      const baseBranch = req.query['base'] as string | undefined;
      const { getDiffSummary, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) {
        res.json({ filesAdded: [], filesModified: [], filesDeleted: [], totalAdditions: 0, totalDeletions: 0 });
        return;
      }
      const summary = await getDiffSummary(config.root, baseBranch);
      res.json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Diff summary failed: ${msg}` });
    }
  });

  // API: parsed diff for a commit (rich diff view with per-file hunks)
  app.get('/api/git/diff/:hash/parsed', async (req, res) => {
    try {
      const hash = req.params['hash'];
      if (!hash) { res.status(400).json({ error: 'Missing hash' }); return; }
      const { getParsedDiff, isGitRepo } = await import('../core/git.js');
      if (!(await isGitRepo(config.root))) {
        res.json({ files: [], stats: { additions: 0, deletions: 0, filesChanged: 0 } });
        return;
      }
      const result = await getParsedDiff(config.root, hash);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Parsed diff failed: ${msg}` });
    }
  });

  // API: migrate .wikimem/history snapshots to git commits
  app.post('/api/git/migrate-history', async (_req, res) => {
    try {
      const { migrateHistoryToGit } = await import('../core/git.js');
      const result = await migrateHistoryToGit(config);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Migration failed: ${msg}` });
    }
  });

  // === RAW FILE PREVIEW ENDPOINTS ===

  // API: serve raw file with correct content-type (for PDF, images, video, audio)
  app.get('/api/raw/file', (req, res) => {
    try {
      let filePath = String(req.query['path'] ?? '');
      if (filePath.startsWith('/')) filePath = filePath.slice(1);
      if (!filePath) { res.status(400).json({ error: 'Missing path query param' }); return; }
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

  // API: date-folder summary — lists all files in a date-stamped raw directory
  app.get('/api/raw/date-summary', (req, res) => {
    try {
      const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
      let dateParam = String(req.query['date'] ?? '');
      if (!dateParam || !DATE_DIR_RE.test(dateParam)) {
        res.status(400).json({ error: 'Missing or invalid date (expected YYYY-MM-DD)' });
        return;
      }
      const dateDir = join(config.rawDir, dateParam);
      const resolvedDate = resolve(dateDir);
      if (!resolvedDate.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!existsSync(resolvedDate)) {
        res.json({ date: dateParam, files: [], uncataloged: [] });
        return;
      }

      interface DateFileMeta {
        name: string;
        path: string;
        size: number;
        mtime: string;
        ext: string;
        wikiPages: string[];
      }

      function collectFiles(dir: string, relPrefix: string): DateFileMeta[] {
        const result: DateFileMeta[] = [];
        for (const entry of readdirSync(dir).sort()) {
          if (entry.startsWith('.') || entry.endsWith('.meta.json')) continue;
          const full = join(dir, entry);
          const st = statSync(full);
          const relPath = relPrefix ? `${relPrefix}/${entry}` : entry;
          if (st.isDirectory()) {
            result.push(...collectFiles(full, relPath));
          } else {
            // Read wiki links from .meta.json if present
            const metaPath = full + '.meta.json';
            let wikiPages: string[] = [];
            if (existsSync(metaPath)) {
              try {
                const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
                const pages = meta['wikiPages'] ?? meta['pages'] ?? meta['wiki_pages'];
                if (Array.isArray(pages)) wikiPages = pages.map(String);
              } catch { /* ignore */ }
            }
            result.push({
              name: entry,
              path: `${dateParam}/${relPath}`,
              size: st.size,
              mtime: st.mtime.toISOString(),
              ext: extname(entry).toLowerCase().replace('.', ''),
              wikiPages,
            });
          }
        }
        return result;
      }

      // Also collect uncataloged files (root-level raw files not in any date dir)
      const uncataloged: DateFileMeta[] = [];
      for (const entry of readdirSync(config.rawDir).sort()) {
        if (entry.startsWith('.') || entry.endsWith('.meta.json')) continue;
        const full = join(config.rawDir, entry);
        const st = statSync(full);
        if (!st.isDirectory()) {
          const metaPath = full + '.meta.json';
          let wikiPages: string[] = [];
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
              const pages = meta['wikiPages'] ?? meta['pages'] ?? meta['wiki_pages'];
              if (Array.isArray(pages)) wikiPages = pages.map(String);
            } catch { /* ignore */ }
          }
          uncataloged.push({
            name: entry,
            path: entry,
            size: st.size,
            mtime: st.mtime.toISOString(),
            ext: extname(entry).toLowerCase().replace('.', ''),
            wikiPages,
          });
        }
      }

      res.json({
        date: dateParam,
        files: collectFiles(resolvedDate, ''),
        uncataloged,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Date summary failed: ${msg}` });
    }
  });

  // API: render DOCX to HTML using mammoth (for rich preview)
  app.get('/api/raw/docx-html', async (req, res) => {
    try {
      let filePath = String(req.query['path'] ?? '');
      if (filePath.startsWith('/')) filePath = filePath.slice(1);
      if (!filePath) { res.status(400).json({ error: 'Missing path query param' }); return; }
      const decoded = decodeURIComponent(filePath);
      const fullPath = join(config.rawDir, decoded);
      const resolved = resolve(fullPath);
      if (!resolved.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied' }); return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' }); return;
      }
      const ext = extname(resolved).toLowerCase();
      if (ext !== '.docx' && ext !== '.doc') {
        res.status(400).json({ error: 'Not a Word document' }); return;
      }
      const mammoth = await import('mammoth');
      const buffer = readFileSync(resolved);
      const result = await mammoth.convertToHtml({ buffer });
      res.json({ html: result.value, messages: result.messages.map(m => m.message) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `DOCX render failed: ${msg}` });
    }
  });

  // API: extract PPTX slides as structured JSON (for slide viewer)
  app.get('/api/raw/pptx-slides', async (req, res) => {
    try {
      let filePath = String(req.query['path'] ?? '');
      if (filePath.startsWith('/')) filePath = filePath.slice(1);
      if (!filePath) { res.status(400).json({ error: 'Missing path query param' }); return; }
      const decoded = decodeURIComponent(filePath);
      const fullPath = join(config.rawDir, decoded);
      const resolved = resolve(fullPath);
      if (!resolved.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied' }); return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' }); return;
      }
      const ext = extname(resolved).toLowerCase();
      if (ext !== '.pptx' && ext !== '.ppt') {
        res.status(400).json({ error: 'Not a PowerPoint file' }); return;
      }
      const { processPptx } = await import('../processors/pptx.js');
      const result = await processPptx(resolved);
      // Parse slide content into structured slide objects
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(resolved);
      const entries = zip.getEntries();
      const slideEntries: Map<number, string> = new Map();
      const noteEntries: Map<number, string> = new Map();
      for (const entry of entries) {
        const name = entry.entryName;
        const sm = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (sm?.[1]) slideEntries.set(parseInt(sm[1], 10), entry.getData().toString('utf-8'));
        const nm = name.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
        if (nm?.[1]) noteEntries.set(parseInt(nm[1], 10), entry.getData().toString('utf-8'));
      }
      const slideNums = [...slideEntries.keys()].sort((a, b) => a - b);
      // Extract plain text per slide for structured JSON response
      const slides = slideNums.map((num) => {
        const xml = slideEntries.get(num) ?? '';
        const noteXml = noteEntries.get(num) ?? '';
        // Extract all text runs from slide XML
        const texts: string[] = [];
        const tRegex = /<a:t>([^<]*)<\/a:t>/g;
        let m: RegExpExecArray | null;
        while ((m = tRegex.exec(xml)) !== null) {
          const t = m[1]?.trim();
          if (t) texts.push(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
        }
        // Extract notes
        const noteTexts: string[] = [];
        const ntRegex = /<a:t>([^<]*)<\/a:t>/g;
        let nm2: RegExpExecArray | null;
        while ((nm2 = ntRegex.exec(noteXml)) !== null) {
          const t = nm2[1]?.trim();
          if (t) noteTexts.push(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
        }
        // First distinct text chunk is likely the title
        const title = texts[0] ?? `Slide ${num}`;
        const body = texts.slice(1);
        const notes = noteTexts.filter(t => !texts.includes(t) && !/^\d+$/.test(t));
        return { slideNumber: num, title, body, notes };
      });
      res.json({ slideCount: slides.length, slides, title: result.title });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `PPTX parse failed: ${msg}` });
    }
  });

  // API: raw file metadata (for preview header)
  app.get('/api/raw/meta', (req, res) => {
    try {
      let filePath = String(req.query['path'] ?? '');
      if (filePath.startsWith('/')) filePath = filePath.slice(1);
      if (!filePath) { res.status(400).json({ error: 'Missing path query param' }); return; }
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

      const documentExts = ['.docx', '.doc', '.pptx', '.ppt', '.rtf', '.odt', '.odp'];

      let previewType: string;
      if (imageExts.includes(ext)) previewType = 'image';
      else if (videoExts.includes(ext)) previewType = 'video';
      else if (audioExts.includes(ext)) previewType = 'audio';
      else if (pdfExts.includes(ext)) previewType = 'pdf';
      else if (spreadsheetExts.includes(ext)) previewType = 'spreadsheet';
      else if (textExts.includes(ext)) previewType = 'text';
      else if (documentExts.includes(ext)) previewType = 'document';
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

  // ─── Raw File Operations (Cursor-Parity) ──────────────────────────────────

  // POST /api/raw/rename — rename a raw file
  app.post('/api/raw/rename', async (req, res) => {
    try {
      const { oldPath, newPath } = req.body as { oldPath?: string; newPath?: string };
      if (!oldPath || !newPath) { res.status(400).json({ error: 'Missing oldPath or newPath' }); return; }
      const resolvedOld = resolve(config.rawDir, oldPath);
      const resolvedNew = resolve(config.rawDir, newPath);
      if (!resolvedOld.startsWith(resolve(config.rawDir)) || !resolvedNew.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied: path outside raw directory' }); return;
      }
      if (!existsSync(resolvedOld)) { res.status(404).json({ error: 'File not found' }); return; }
      mkdirSync(dirname(resolvedNew), { recursive: true });
      renameSync(resolvedOld, resolvedNew);
      try {
        const { autoCommit, isGitRepo } = await import('../core/git.js');
        if (await isGitRepo(config.root)) {
          await autoCommit(config.root, 'manual', `rename raw "${basename(oldPath)}" → "${basename(newPath)}"`);
        }
      } catch { /* non-fatal */ }
      res.json({ status: 'renamed', oldPath, newPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Rename failed: ${msg}` });
    }
  });

  // DELETE /api/raw/file — delete a raw file
  app.delete('/api/raw/file', async (req, res) => {
    try {
      const filePath = req.query['path'] as string | undefined;
      if (!filePath) { res.status(400).json({ error: 'Missing path query param' }); return; }
      const resolved = resolve(config.rawDir, filePath);
      if (!resolved.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied: path outside raw directory' }); return;
      }
      if (!existsSync(resolved)) { res.status(404).json({ error: 'File not found' }); return; }
      fsUnlinkSync(resolved);
      try {
        const { autoCommit, isGitRepo } = await import('../core/git.js');
        if (await isGitRepo(config.root)) {
          await autoCommit(config.root, 'manual', `delete raw file "${basename(filePath)}"`);
        }
      } catch { /* non-fatal */ }
      res.json({ status: 'deleted', path: filePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Delete failed: ${msg}` });
    }
  });

  // POST /api/raw/move — move a raw file to a different directory
  app.post('/api/raw/move', async (req, res) => {
    try {
      const { path: filePath, targetDir } = req.body as { path?: string; targetDir?: string };
      if (!filePath || !targetDir) { res.status(400).json({ error: 'Missing path or targetDir' }); return; }
      const resolvedSrc = resolve(config.rawDir, filePath);
      const resolvedDest = resolve(config.rawDir, targetDir, basename(filePath));
      if (!resolvedSrc.startsWith(resolve(config.rawDir)) || !resolvedDest.startsWith(resolve(config.rawDir))) {
        res.status(403).json({ error: 'Access denied: path outside raw directory' }); return;
      }
      if (!existsSync(resolvedSrc)) { res.status(404).json({ error: 'Source file not found' }); return; }
      mkdirSync(dirname(resolvedDest), { recursive: true });
      renameSync(resolvedSrc, resolvedDest);
      try {
        const { autoCommit, isGitRepo } = await import('../core/git.js');
        if (await isGitRepo(config.root)) {
          await autoCommit(config.root, 'manual', `move raw "${basename(filePath)}" → ${targetDir}/`);
        }
      } catch { /* non-fatal */ }
      res.json({ status: 'moved', from: filePath, to: targetDir + '/' + basename(filePath) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Move failed: ${msg}` });
    }
  });

  // POST /api/pages/:title/move — move a wiki page to a different category folder
  app.post('/api/pages/:title/move', async (req, res) => {
    try {
      const title = req.params['title'];
      const { targetCategory } = req.body as { targetCategory?: string };
      if (!title || !targetCategory) { res.status(400).json({ error: 'Missing title or targetCategory' }); return; }

      const pages = listWikiPages(config.wikiDir);
      const titleLower = title.toLowerCase();
      const slugified = titleLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const match = pages.find((p) => {
        const fileSlug = basename(p, '.md');
        if (fileSlug === title || fileSlug === slugified) return true;
        try { return readWikiPage(p).title.toLowerCase() === titleLower; } catch { return false; }
      });
      if (!match) { res.status(404).json({ error: 'Page not found' }); return; }

      const destDir = resolve(config.wikiDir, targetCategory);
      if (!destDir.startsWith(resolve(config.wikiDir))) {
        res.status(403).json({ error: 'Access denied: category outside wiki directory' }); return;
      }
      mkdirSync(destDir, { recursive: true });
      const destPath = join(destDir, basename(match));
      renameSync(match, destPath);

      // Update frontmatter category/type
      let content = readFileSync(destPath, 'utf-8');
      if (content.match(/^type:\s*.+$/m)) {
        content = content.replace(/^type:\s*.+$/m, `type: ${targetCategory}`);
      } else if (content.match(/^category:\s*.+$/m)) {
        content = content.replace(/^category:\s*.+$/m, `category: ${targetCategory}`);
      }
      writeFileSync(destPath, content, 'utf-8');

      try {
        const { autoCommit, isGitRepo } = await import('../core/git.js');
        if (await isGitRepo(config.root)) {
          await autoCommit(config.root, 'manual', `move page "${title}" → ${targetCategory}/`);
        }
      } catch { /* non-fatal */ }
      res.json({ status: 'moved', title, targetCategory, newPath: relative(config.wikiDir, destPath) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Move failed: ${msg}` });
    }
  });

  // POST /api/folders — create a new folder inside wiki/ or raw/
  app.post('/api/folders', (req, res) => {
    try {
      const { path: folderPath } = req.body as { path?: string };
      if (!folderPath) { res.status(400).json({ error: 'Missing path' }); return; }
      const resolved = resolve(config.root, folderPath);
      const wikiBase = resolve(config.wikiDir);
      const rawBase = resolve(config.rawDir);
      if (!resolved.startsWith(wikiBase) && !resolved.startsWith(rawBase)) {
        res.status(403).json({ error: 'Access denied: folder must be inside wiki/ or raw/' }); return;
      }
      mkdirSync(resolved, { recursive: true });
      res.json({ status: 'created', path: folderPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Create folder failed: ${msg}` });
    }
  });

  // ─── OAuth Connector System ───────────────────────────────────────────────

  const OAUTH_PROVIDERS: Record<string, {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string;
    clientIdKey: string;
    clientSecretKey: string;
  }> = {
    github: {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: 'repo read:user',
      clientIdKey: 'github_client_id',
      clientSecretKey: 'github_client_secret',
    },
    slack: {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: 'channels:history channels:read channels:join users:read',
      clientIdKey: 'slack_client_id',
      clientSecretKey: 'slack_client_secret',
    },
    google: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly',
      clientIdKey: 'google_client_id',
      clientSecretKey: 'google_client_secret',
    },
    linear: {
      authorizeUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: 'read',
      clientIdKey: 'linear_client_id',
      clientSecretKey: 'linear_client_secret',
    },
    jira: {
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: 'read:jira-work read:jira-user offline_access',
      clientIdKey: 'jira_client_id',
      clientSecretKey: 'jira_client_secret',
    },
    notion: {
      authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      scopes: '',
      clientIdKey: 'notion_client_id',
      clientSecretKey: 'notion_client_secret',
    },
    discord: {
      authorizeUrl: 'https://discord.com/api/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      scopes: 'identify guilds messages.read',
      clientIdKey: 'discord_client_id',
      clientSecretKey: 'discord_client_secret',
    },
    dropbox: {
      authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scopes: 'files.metadata.read files.content.read',
      clientIdKey: 'dropbox_client_id',
      clientSecretKey: 'dropbox_client_secret',
    },
    gitlab: {
      authorizeUrl: 'https://gitlab.com/oauth/authorize',
      tokenUrl: 'https://gitlab.com/oauth/token',
      scopes: 'read_user read_repository read_api',
      clientIdKey: 'gitlab_client_id',
      clientSecretKey: 'gitlab_client_secret',
    },
    asana: {
      authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
      tokenUrl: 'https://app.asana.com/-/oauth_token',
      scopes: 'default',
      clientIdKey: 'asana_client_id',
      clientSecretKey: 'asana_client_secret',
    },
    figma: {
      authorizeUrl: 'https://www.figma.com/oauth',
      tokenUrl: 'https://www.figma.com/api/oauth/token',
      scopes: 'file_read',
      clientIdKey: 'figma_client_id',
      clientSecretKey: 'figma_client_secret',
    },
    hubspot: {
      authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
      tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      scopes: 'content crm.objects.contacts.read crm.objects.companies.read',
      clientIdKey: 'hubspot_client_id',
      clientSecretKey: 'hubspot_client_secret',
    },
    intercom: {
      authorizeUrl: 'https://app.intercom.com/oauth',
      tokenUrl: 'https://api.intercom.io/auth/eagle/token',
      scopes: '',
      clientIdKey: 'intercom_client_id',
      clientSecretKey: 'intercom_client_secret',
    },
    airtable: {
      authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
      tokenUrl: 'https://airtable.com/oauth2/v1/token',
      scopes: 'data.records:read schema.bases:read',
      clientIdKey: 'airtable_client_id',
      clientSecretKey: 'airtable_client_secret',
    },
  };

  const oauthStates = new Map<string, { provider: string; createdAt: number }>();

  /**
   * Resolve OAuth credentials: bundled defaults → env vars → config.yaml.
   * Bundled defaults ship with the npm package (pre-registered WikiMem OAuth apps).
   * Env vars override bundled defaults (for development/self-hosted).
   * config.yaml is the user-level fallback.
   */
  function resolveOAuthCredentials(providerName: string): { clientId: string; clientSecret: string } | null {
    const providerConfig = OAUTH_PROVIDERS[providerName];
    if (!providerConfig) return null;

    // 1. Environment variables (highest priority — override bundled defaults)
    const envPrefix = `WIKIMEM_${providerName.toUpperCase()}`;
    const envId = process.env[`${envPrefix}_CLIENT_ID`];
    const envSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
    if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

    // 2. Bundled defaults (pre-registered WikiMem OAuth apps shipped with package)
    const bundled = getBundledCredentials(providerName);
    if (bundled) return bundled;

    // 3. User-configured credentials in config.yaml
    try {
      const { loadConfig: lc } = require('../core/config.js') as { loadConfig: (p: string) => Record<string, unknown> };
      const userConfig = lc(config.configPath);
      const configId = userConfig[providerConfig.clientIdKey] as string | undefined;
      const configSecret = userConfig[providerConfig.clientSecretKey] as string | undefined;
      if (configId && configSecret) return { clientId: configId, clientSecret: configSecret };
    } catch { /* config load failure is non-fatal */ }

    return null;
  }

  function getTokenStorePath(): string {
    return join(vaultRoot, '.wikimem', 'tokens.json');
  }

  function loadOAuthTokens(): Record<string, { access_token: string; refresh_token?: string; scope?: string; connectedAt: string }> {
    const tokenPath = getTokenStorePath();
    if (!existsSync(tokenPath)) return {};
    try { return JSON.parse(readFileSync(tokenPath, 'utf-8')); } catch { return {}; }
  }

  function saveOAuthToken(provider: string, tokenData: { access_token: string; refresh_token?: string; scope?: string }): void {
    const tokenPath = getTokenStorePath();
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    const tokens = loadOAuthTokens();
    tokens[provider] = { ...tokenData, connectedAt: new Date().toISOString() };
    writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Defense in depth: ensure existing files get 0600 even if previously 0644
    try { chmodSync(tokenPath, 0o600); } catch { /* non-fatal */ }
  }

  // GET /api/auth/tokens — list which providers have tokens stored + credential availability
  app.get('/api/auth/tokens', (_req, res) => {
    try {
      const tokens = loadOAuthTokens();
      const result: Record<string, { connected: boolean; connectedAt?: string; hasCredentials: boolean; hasDeviceFlow?: boolean }> = {};
      // OAuth providers — include credential availability
      for (const provider of Object.keys(OAUTH_PROVIDERS)) {
        const token = tokens[provider];
        const creds = resolveOAuthCredentials(provider);
        result[provider] = {
          connected: !!token,
          connectedAt: token?.connectedAt,
          hasCredentials: !!creds,
          ...(provider === 'github' ? { hasDeviceFlow: !!resolveDeviceFlowClientId() } : {}),
        };
      }
      // API-key and bot-token providers — include any that have tokens stored
      for (const [provider, token] of Object.entries(tokens)) {
        if (!result[provider]) {
          result[provider] = {
            connected: true,
            connectedAt: token?.connectedAt,
            hasCredentials: true,
          };
        }
      }
      res.json(result);
    } catch { res.json({}); }
  });

  // GET /api/auth/start/:provider — generate OAuth authorize URL
  app.get('/api/auth/start/:provider', async (req, res) => {
    try {
      const providerName = req.params['provider'];
      if (!providerName) { res.status(400).json({ error: 'Missing provider' }); return; }
      const providerConfig = OAUTH_PROVIDERS[providerName];
      if (!providerConfig) { res.status(400).json({ error: `Unknown provider: ${providerName}` }); return; }

      const creds = resolveOAuthCredentials(providerName);
      if (!creds) {
        res.status(400).json({ error: 'no_credentials', message: `No OAuth credentials found for ${providerName}. Add credentials in Settings or set WIKIMEM_${providerName.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET env vars.` });
        return;
      }

      const state = randomBytes(24).toString('hex');
      oauthStates.set(state, { provider: providerName, createdAt: Date.now() });

      // Clean stale states (>10 min)
      for (const [key, val] of oauthStates) {
        if (Date.now() - val.createdAt > 600_000) oauthStates.delete(key);
      }

      const redirectUri = `http://localhost:${port}/api/auth/callback`;
      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        scope: providerConfig.scopes,
        state,
        response_type: 'code',
        ...(providerName === 'google' ? { access_type: 'offline', prompt: 'consent' } : {}),
        ...(providerName === 'jira' ? { audience: 'api.atlassian.com', prompt: 'consent' } : {}),
      });
      const authorizeUrl = `${providerConfig.authorizeUrl}?${params.toString()}`;
      res.json({ url: authorizeUrl, state });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `OAuth start failed: ${msg}` });
    }
  });

  // GET /api/auth/callback — OAuth callback handler
  app.get('/api/auth/callback', async (req, res) => {
    try {
      const code = req.query['code'] as string | undefined;
      const state = req.query['state'] as string | undefined;
      if (!code || !state) {
        res.status(400).send('<h2>Missing code or state</h2>'); return;
      }
      const stateData = oauthStates.get(state);
      if (!stateData) {
        res.status(400).send('<h2>Invalid or expired state token</h2>'); return;
      }
      oauthStates.delete(state);

      const providerConfig = OAUTH_PROVIDERS[stateData.provider];
      if (!providerConfig) { res.status(400).send('<h2>Unknown provider</h2>'); return; }

      const creds = resolveOAuthCredentials(stateData.provider);
      if (!creds) {
        res.status(400).send('<h2>Missing client credentials</h2><p>Configure OAuth credentials in Settings or via environment variables.</p>'); return;
      }

      const redirectUri = `http://localhost:${port}/api/auth/callback`;
      const tokenRes = await fetch(providerConfig.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenBody = await tokenRes.json() as Record<string, unknown>;
      const accessToken = tokenBody['access_token'] as string | undefined;
      if (!accessToken) {
        res.status(400).send(`<h2>Token exchange failed</h2><pre>${JSON.stringify(tokenBody, null, 2)}</pre>`); return;
      }

      saveOAuthToken(stateData.provider, {
        access_token: accessToken,
        refresh_token: tokenBody['refresh_token'] as string | undefined,
        scope: tokenBody['scope'] as string | undefined,
      });

      // Do NOT auto-sync on connect — user must preview and select what to sync first.

      const providerDisplay = stateData.provider.charAt(0).toUpperCase() + stateData.provider.slice(1);
      res.send(`<!DOCTYPE html><html><head><style>
        body { font-family: Inter, system-ui, sans-serif; background: #1e1e1e; color: #ccc; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #252526; border: 1px solid #3e3e3e; border-radius: 12px; padding: 32px 40px; text-align: center; }
        h2 { color: #4ec9b0; margin: 0 0 8px; } p { color: #808080; font-size: 14px; }
      </style></head><body><div class="card"><h2>Connected!</h2><p>${providerDisplay} is now linked to WikiMem.</p><p style="margin-top:8px"><small>You can now preview and select what to sync.</small></p></div>
      <script>if(window.opener){window.opener.postMessage({type:'wikimem-oauth-connected',provider:'${stateData.provider}'},'http://localhost:${port}');}setTimeout(function(){window.close()},3000)</script>
      </body></html>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Security: don't leak internal error details to the browser
      if (process.env['NODE_ENV'] !== 'production') console.error('[OAuth callback]', msg);
      res.status(500).send(`<h2>OAuth callback failed</h2><p>The authorization flow did not complete. Please try again or check the server logs.</p>`);
    }
  });

  // DELETE /api/auth/tokens/:provider — disconnect a provider
  app.delete('/api/auth/tokens/:provider', (_req, res) => {
    try {
      const provider = _req.params['provider'];
      if (!provider) { res.status(400).json({ error: 'Missing provider' }); return; }
      const tokenPath = getTokenStorePath();
      const tokens = loadOAuthTokens();
      delete tokens[provider];
      mkdirSync(dirname(tokenPath), { recursive: true });
      writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
      res.json({ status: 'disconnected', provider });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Disconnect failed: ${msg}` });
    }
  });

  // POST /api/auth/tokens/:provider — manually store an API key (for Notion, etc.)
  app.post('/api/auth/tokens/:provider', (req, res) => {
    try {
      const provider = req.params['provider'];
      if (!provider) { res.status(400).json({ error: 'Missing provider' }); return; }
      const { api_key } = req.body as { api_key?: string };
      if (!api_key) { res.status(400).json({ error: 'Missing api_key' }); return; }
      saveOAuthToken(provider, { access_token: api_key });
      res.json({ status: 'connected', provider });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Save token failed: ${msg}` });
    }
  });

  // GET /api/auth/webhook-url — return the persistent ingest webhook URL for this user
  app.get('/api/auth/webhook-url', (_req, res) => {
    try {
      const webhookIdPath = join(vaultRoot, '.wikimem', 'webhook-id.txt');
      let webhookId: string;
      if (existsSync(webhookIdPath)) {
        webhookId = readFileSync(webhookIdPath, 'utf-8').trim();
      } else {
        webhookId = randomBytes(16).toString('hex');
        mkdirSync(dirname(webhookIdPath), { recursive: true });
        writeFileSync(webhookIdPath, webhookId, 'utf-8');
      }
      res.json({ url: `http://localhost:${port}/api/webhook/ingest?key=${webhookId}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Webhook URL failed: ${msg}` });
    }
  });

  // ─── GitHub Device Flow (no client_secret needed) ──────────────────────────

  /**
   * Resolve the GitHub client ID for Device Flow.
   * Priority: env vars → bundled defaults → config.yaml
   */
  function resolveDeviceFlowClientId(): string | null {
    // 1. Env vars (highest priority)
    const deviceId = process.env['WIKIMEM_GITHUB_DEVICE_CLIENT_ID'];
    if (deviceId) return deviceId;
    const regularId = process.env['WIKIMEM_GITHUB_CLIENT_ID'];
    if (regularId) return regularId;

    // 2. Bundled defaults (shipped with package)
    const bundled = getBundledDeviceFlowClientId();
    if (bundled) return bundled;

    // 3. config.yaml (user-configured)
    try {
      const { loadConfig: lc } = require('../core/config.js') as { loadConfig: (p: string) => Record<string, unknown> };
      const userConfig = lc(config.configPath);
      const configId = userConfig['github_client_id'] as string | undefined;
      if (configId) return configId;
    } catch { /* config load failure is non-fatal */ }

    return null;
  }

  // POST /api/auth/device-flow/start — initiate GitHub Device Flow
  app.post('/api/auth/device-flow/start', async (_req, res) => {
    try {
      const clientId = resolveDeviceFlowClientId();
      if (!clientId) {
        res.status(400).json({
          error: 'no_client_id',
          message: 'No GitHub client ID found. Set WIKIMEM_GITHUB_DEVICE_CLIENT_ID or WIKIMEM_GITHUB_CLIENT_ID env var.',
        });
        return;
      }

      const ghRes = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: clientId,
          scope: 'repo read:user',
        }),
      });

      const body = await ghRes.json() as Record<string, unknown>;

      if (body['error']) {
        res.status(400).json({ error: body['error'], message: body['error_description'] ?? 'Device flow initiation failed' });
        return;
      }

      res.json({
        device_code: body['device_code'],
        user_code: body['user_code'],
        verification_uri: body['verification_uri'],
        expires_in: body['expires_in'],
        interval: body['interval'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Device flow start failed: ${msg}` });
    }
  });

  // POST /api/auth/device-flow/poll — poll for token after user enters code
  app.post('/api/auth/device-flow/poll', async (req, res) => {
    try {
      const { device_code } = req.body as { device_code?: string };
      if (!device_code) {
        res.status(400).json({ error: 'missing_device_code', message: 'device_code is required' });
        return;
      }

      const clientId = resolveDeviceFlowClientId();
      if (!clientId) {
        res.status(400).json({ error: 'no_client_id', message: 'No GitHub client ID configured' });
        return;
      }

      const ghRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const body = await ghRes.json() as Record<string, unknown>;
      const error = body['error'] as string | undefined;

      if (error === 'authorization_pending') {
        res.json({ status: 'pending' });
        return;
      }
      if (error === 'slow_down') {
        res.json({ status: 'slow_down' });
        return;
      }
      if (error === 'expired_token') {
        res.json({ status: 'expired' });
        return;
      }
      if (error) {
        res.status(400).json({ status: 'error', error, message: body['error_description'] ?? 'Token exchange failed' });
        return;
      }

      const accessToken = body['access_token'] as string | undefined;
      if (!accessToken) {
        res.status(400).json({ status: 'error', error: 'no_token', message: 'No access_token in response' });
        return;
      }

      saveOAuthToken('github', {
        access_token: accessToken,
        scope: body['scope'] as string | undefined,
      });

      // Do NOT auto-sync on connect — user must preview and select what to sync first.

      res.json({ status: 'complete', access_token: accessToken });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Device flow poll failed: ${msg}` });
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

  // ─── Pipeline Configuration (custom steps) ──────────────────────────────────

  app.get('/api/pipeline/config', async (_req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath) as Record<string, unknown>;
      const pipelineConfig = (userConfig['pipeline'] as Record<string, unknown>) ?? {};
      const customSteps = (pipelineConfig['custom_steps'] as unknown[]) ?? [];
      const disabledSteps = (pipelineConfig['disabled_steps'] as string[]) ?? [];
      res.json({ custom_steps: customSteps, disabled_steps: disabledSteps });
    } catch {
      res.json({ custom_steps: [], disabled_steps: [] });
    }
  });

  app.put('/api/pipeline/config', async (req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const YAML = await import('yaml');
      const current = loadConfig(config.configPath) as Record<string, unknown>;
      const body = req.body as { custom_steps?: unknown[]; disabled_steps?: string[] };
      const pipeline = (current['pipeline'] as Record<string, unknown>) ?? {};
      if (body.custom_steps !== undefined) pipeline['custom_steps'] = body.custom_steps;
      if (body.disabled_steps !== undefined) pipeline['disabled_steps'] = body.disabled_steps;
      current['pipeline'] = pipeline;
      writeFileSync(config.configPath, YAML.stringify(current), 'utf-8');
      res.json({ status: 'saved' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to save pipeline config: ${msg}` });
    }
  });

  // ─── Pipeline Prompt Overrides (UXO-077) ──────────────────────────────────

  // GET /api/pipeline/prompts — returns all prompts (defaults merged with user overrides)
  app.get('/api/pipeline/prompts', async (_req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const { DEFAULT_PROMPTS, PROMPT_STEP_LABELS } = await import('../core/pipeline-prompts.js');
      const userConfig = loadConfig(config.configPath);
      const overrides = userConfig.pipeline?.prompts ?? {};
      const result: Record<string, { label: string; value: string; isDefault: boolean }> = {};
      for (const [step, defaultValue] of Object.entries(DEFAULT_PROMPTS)) {
        const override = overrides[step];
        result[step] = {
          label: PROMPT_STEP_LABELS[step] ?? step,
          value: (override && override.trim().length > 0) ? override : defaultValue,
          isDefault: !(override && override.trim().length > 0),
        };
      }
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load prompts: ${msg}` });
    }
  });

  // PUT /api/pipeline/prompts — saves user overrides for one or more steps
  app.put('/api/pipeline/prompts', async (req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const { DEFAULT_PROMPTS } = await import('../core/pipeline-prompts.js');
      const YAML = await import('yaml');
      const body = req.body as Record<string, string>;

      // Validate: only accept known step IDs and non-empty values
      for (const [step, value] of Object.entries(body)) {
        if (!(step in DEFAULT_PROMPTS)) {
          res.status(400).json({ error: `Unknown prompt step: "${step}"` });
          return;
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
          res.status(400).json({ error: `Prompt for "${step}" must be a non-empty string` });
          return;
        }
      }

      const current = loadConfig(config.configPath) as Record<string, unknown>;
      const pipeline = (current['pipeline'] as Record<string, unknown>) ?? {};
      const existingPrompts = (pipeline['prompts'] as Record<string, string>) ?? {};
      pipeline['prompts'] = { ...existingPrompts, ...body };
      current['pipeline'] = pipeline;
      writeFileSync(config.configPath, YAML.stringify(current), 'utf-8');
      res.json({ status: 'saved' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to save prompts: ${msg}` });
    }
  });

  // POST /api/pipeline/prompts/:step/reset — restore a step to its default prompt
  app.post('/api/pipeline/prompts/:step/reset', async (req, res) => {
    try {
      const { loadConfig } = await import('../core/config.js');
      const { DEFAULT_PROMPTS } = await import('../core/pipeline-prompts.js');
      const YAML = await import('yaml');
      const step = req.params['step'] ?? '';

      if (!(step in DEFAULT_PROMPTS)) {
        res.status(400).json({ error: `Unknown prompt step: "${step}"` });
        return;
      }

      const current = loadConfig(config.configPath) as Record<string, unknown>;
      const pipeline = (current['pipeline'] as Record<string, unknown>) ?? {};
      const prompts = (pipeline['prompts'] as Record<string, string>) ?? {};
      delete prompts[step];
      if (Object.keys(prompts).length > 0) {
        pipeline['prompts'] = prompts;
      } else {
        delete pipeline['prompts'];
      }
      current['pipeline'] = pipeline;
      writeFileSync(config.configPath, YAML.stringify(current), 'utf-8');
      res.json({ status: 'reset', defaultValue: DEFAULT_PROMPTS[step] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to reset prompt: ${msg}` });
    }
  });

  // ─── Automation 3: Webhook Ingest ─────────────────────────────────────────

  // Track files currently being ingested by webhook to avoid double-ingest with watcher
  const webhookIngestingFiles = new Set<string>();

  // POST /api/webhook/ingest — accept external content, run ingest pipeline
  app.post('/api/webhook/ingest', async (req, res) => {
    try {
      const { content, title, source, tags, metadata } = req.body as {
        content?: string;
        title?: string;
        source?: string;
        tags?: string[];
        metadata?: Record<string, string>;
      };
      if (!content || content.trim().length === 0) {
        res.status(400).json({ error: 'Missing or empty content field' });
        return;
      }

      const now = new Date().toISOString().split('T')[0] ?? '';
      const pageTitle = title ?? `Webhook Ingest ${new Date().toISOString()}`;
      const markdown = `# ${pageTitle}\n\n${source ? `Source: ${source}\n` : ''}Ingested via webhook: ${new Date().toISOString()}\n\n${content}`;

      // Write to raw/ so ingest pipeline can find it
      const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
      const { join: joinPath } = await import('node:path');
      const { slugify } = await import('../core/vault.js');
      const dateDir = joinPath(config.rawDir, now);
      mkdir(dateDir, { recursive: true });
      const filePath = joinPath(dateDir, `${slugify(pageTitle.substring(0, 60))}-webhook.md`);
      write(filePath, markdown, 'utf-8');

      // Tell the watcher to skip this file (webhook handles ingest)
      webhookIngestingFiles.add(filePath);

      const { ingestSource } = await import('../core/ingest.js');
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const { appendAuditEntry } = await import('../core/audit-trail.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);

      let result;
      try {
        result = await ingestSource(filePath, config, provider, {
          verbose: false,
          tags: tags ?? [],
          metadata,
          addedBy: 'webhook',
        });
      } catch (ingestErr) {
        const ingestMsg = ingestErr instanceof Error ? ingestErr.message : String(ingestErr);
        appendAuditEntry(vaultRoot, {
          action: 'ingest',
          actor: 'webhook',
          source: source ?? filePath,
          summary: `Webhook ingest FAILED: "${pageTitle}" — ${ingestMsg.substring(0, 200)}`,
          pagesAffected: [pageTitle],
        });
        webhookIngestingFiles.delete(filePath);
        res.status(500).json({ error: `Webhook ingest failed: ${ingestMsg}` });
        return;
      }

      appendAuditEntry(vaultRoot, {
        action: 'ingest',
        actor: 'webhook',
        source: source ?? filePath,
        summary: `Webhook ingest: "${pageTitle}" — ${result.pagesUpdated} pages created.`,
        pagesAffected: [pageTitle],
      });
      webhookIngestingFiles.delete(filePath);

      res.json({
        success: !result.rejected,
        pagesCreated: result.pagesUpdated,
        title: result.title,
        rawPath: result.rawPath,
        rejected: result.rejected ?? false,
        rejectionReason: result.rejectionReason,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Webhook ingest failed: ${msg}` });
    }
  });

  // ─── Centralized Ingestion Gateway ───────────────────────────────────────

  // POST /api/gateway/ingest — universal ingestion from any source
  app.post('/api/gateway/ingest', async (req, res) => {
    const runId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { content, url, source, title, tags, metadata } = req.body as {
        content?: string;
        url?: string;
        source?: string;
        title?: string;
        tags?: string[];
        metadata?: Record<string, string>;
      };

      const sourceLabel = source ?? 'api';
      const validSources = new Set(['email', 'slack', 'webhook', 'api', 'web']);
      if (source && !validSources.has(source)) {
        res.status(400).json({ runId, error: `Invalid source. Expected one of: ${[...validSources].join(', ')}` });
        return;
      }

      if (!content && !url) {
        res.status(400).json({ runId, error: 'Must provide at least content or url' });
        return;
      }

      const { ingestSource } = await import('../core/ingest.js');
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const { slugify } = await import('../core/vault.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);

      const auditActor = 'webhook' as const;

      // URL-only ingestion: pass URL directly to ingestSource
      if (url && !content) {
        const result = await ingestSource(url, config, provider, {
          verbose: false,
          tags: tags ?? [],
          metadata: { ...metadata, gateway_source: sourceLabel, gateway_run: runId },
          addedBy: 'webhook',
        });
        res.json({
          runId,
          status: result.rejected ? 'rejected' : 'ingested',
          pagesCreated: result.pagesUpdated ?? 0,
          title: result.title,
          rejected: result.rejected ?? false,
          rejectionReason: result.rejectionReason,
        });
        return;
      }

      // Content-based: write to raw/ then ingest
      const now = new Date().toISOString().split('T')[0] ?? '';
      const pageTitle = title ?? `Gateway ${sourceLabel} ${new Date().toISOString()}`;
      const frontmatter = [
        `source: ${sourceLabel}`,
        `ingested_via: gateway`,
        `run_id: ${runId}`,
        ...(tags?.length ? [`tags: [${tags.join(', ')}]`] : []),
        ...(metadata ? Object.entries(metadata).map(([k, v]) => `${k}: ${v}`) : []),
      ].join('\n');
      const markdown = `---\ntitle: "${pageTitle}"\n${frontmatter}\n---\n\n${content}`;

      const dateDir = join(config.rawDir, now);
      mkdirSync(dateDir, { recursive: true });
      const slug = slugify(pageTitle.substring(0, 60));
      const filePath = join(dateDir, `${slug}-gw-${sourceLabel}.md`);
      writeFileSync(filePath, markdown, 'utf-8');

      webhookIngestingFiles.add(filePath);
      let result;
      try {
        result = await ingestSource(filePath, config, provider, {
          verbose: false,
          tags: tags ?? [],
          metadata: { ...metadata, gateway_source: sourceLabel, gateway_run: runId },
          addedBy: 'webhook',
        });
      } finally {
        webhookIngestingFiles.delete(filePath);
      }

      try {
        const { appendAuditEntry } = await import('../core/audit-trail.js');
        appendAuditEntry(vaultRoot, {
          action: 'ingest',
          actor: auditActor,
          source: url ?? filePath,
          summary: `Gateway ingest (${sourceLabel}): "${pageTitle}" — ${result.pagesUpdated} pages created.`,
          pagesAffected: [pageTitle],
        });
      } catch { /* non-fatal */ }

      res.json({
        runId,
        status: result.rejected ? 'rejected' : 'ingested',
        pagesCreated: result.pagesUpdated ?? 0,
        title: result.title,
        rejected: result.rejected ?? false,
        rejectionReason: result.rejectionReason,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ runId, status: 'error', error: `Gateway ingest failed: ${msg}` });
    }
  });

  // ─── Audit Trail API ──────────────────────────────────────────────────────

  // GET /api/audit-trail?limit=50&actor=all&action=all
  app.get('/api/audit-trail', async (req, res) => {
    try {
      const limit = parseInt(req.query['limit'] as string) || 50;
      const actor = (req.query['actor'] as string) || 'all';
      const action = (req.query['action'] as string) || 'all';
      const since = req.query['since'] as string | undefined;
      const before = req.query['before'] as string | undefined;
      const { readAuditTrail } = await import('../core/audit-trail.js');
      const entries = readAuditTrail(vaultRoot, limit, actor, action, since, before);
      res.json({ entries, total: entries.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Automation Settings API ─────────────────────────────────────────────

  function getAutomationSettingsPath(): string {
    return join(vaultRoot, '.wikimem', 'automations.json');
  }

  function loadAutomationSettings(): Record<string, Record<string, unknown>> {
    const settingsPath = getAutomationSettingsPath();
    if (!existsSync(settingsPath)) return {};
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch { return {}; }
  }

  function saveAutomationSettings(settings: Record<string, Record<string, unknown>>): void {
    const settingsPath = getAutomationSettingsPath();
    const dir = join(vaultRoot, '.wikimem');
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  // GET /api/automations/settings — read all automation toggle state
  app.get('/api/automations/settings', (_req, res) => {
    try {
      const settings = loadAutomationSettings();
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /api/automations/settings — update a single automation setting
  app.patch('/api/automations/settings', (req, res) => {
    try {
      const { automation, key, value } = req.body as {
        automation?: string;
        key?: string;
        value?: unknown;
      };
      if (!automation || !key) {
        res.status(400).json({ error: 'Missing automation or key' });
        return;
      }
      const settings = loadAutomationSettings();
      if (!settings[automation]) settings[automation] = {};
      settings[automation]![key] = value;
      saveAutomationSettings(settings);
      res.json({ status: 'saved', automation, key, value });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/automations/sourcing/run — trigger smart sourcing (alias for /api/automations/scrape)
  app.post('/api/automations/sourcing/run', async (req, res) => {
    try {
      const { runSmartScraper } = await import('../core/scraper.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const result = await runSmartScraper(config, userConfig, { dryRun: false, maxItems: 10 });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Sourcing run failed: ${msg}` });
    }
  });

  // ─── Observer APIs ────────────────────────────────────────────────────────

  // POST /api/observer/run — trigger observer manually
  app.post('/api/observer/run', async (req, res) => {
    try {
      const { autoImprove, maxImprovements, maxBudget, model } = req.body as { autoImprove?: boolean; maxImprovements?: number; maxBudget?: number; model?: string } ?? {};
      const { runObserver } = await import('../core/observer.js');
      const report = await runObserver(config, { autoImprove, maxImprovements, maxBudget, model });
      res.json({
        success: true,
        date: report.date,
        totalPages: report.totalPages,
        pagesReviewed: report.pagesReviewed,
        averageScore: report.averageScore,
        maxScore: report.maxScore,
        orphanCount: report.orphans.length,
        gapCount: report.gaps.length,
        contradictionCount: report.contradictions.length,
        contradictions: report.contradictions,
        improvementCount: report.improvements?.length ?? 0,
        improvements: report.improvements ?? [],
        topIssues: report.topIssues ?? [],
        weakestPages: report.scores.filter(s => s.score < report.maxScore).slice(0, 10).map(s => ({
          title: s.title,
          score: s.score,
          maxScore: s.maxScore,
          issues: s.issues,
        })),
        reportPath: `.wikimem/observer-reports/${report.date}.json`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Observer run failed: ${msg}` });
    }
  });

  // GET /api/observer/reports — list all reports
  app.get('/api/observer/reports', async (_req, res) => {
    try {
      const { listObserverReports } = await import('../core/observer.js');
      const reports = listObserverReports(vaultRoot);
      res.json({ reports });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/observer/reports/:date — get specific report
  app.get('/api/observer/reports/:date', async (req, res) => {
    try {
      const date = req.params['date'];
      if (!date) { res.status(400).json({ error: 'Missing date' }); return; }
      const { readObserverReport } = await import('../core/observer.js');
      const report = readObserverReport(vaultRoot, date);
      if (!report) { res.status(404).json({ error: `No report found for ${date}` }); return; }
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Observer Experiment History (Observer Timeline UI) ───────────────────
  //
  // The self-improvement engine logs every experiment it runs to
  // `<vault>/.wikimem/observer-experiment-log.json`. The UI consumes these
  // routes to render the timeline, filter by pattern/action/result, show detail,
  // and (optionally) stream live progress from a manual run.

  // GET /api/observer/experiments — timeline list + summary (filter support)
  //   Query params:
  //     limit     — cap on returned entries (default 100, max 500)
  //     since     — ISO timestamp; include entries strictly newer than this
  //     pattern   — filter by action (alias: ?action=). Comma-separated OK.
  //     result    — success|failure|neutral (comma-separated OK)
  app.get('/api/observer/experiments', async (req, res) => {
    try {
      const { readExperimentLog } = await import('../core/observer.js');
      const log = readExperimentLog(vaultRoot);
      const entries = Array.isArray(log.entries) ? log.entries : [];

      // Parse filters
      const rawLimit = Number(req.query['limit']);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const sinceRaw = typeof req.query['since'] === 'string' ? req.query['since'] : undefined;
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
      const patternRaw = (req.query['pattern'] ?? req.query['action']) as string | undefined;
      const patternSet = patternRaw
        ? new Set(patternRaw.split(',').map((s) => s.trim()).filter(Boolean))
        : null;
      const resultRaw = typeof req.query['result'] === 'string' ? req.query['result'] : undefined;
      const resultSet = resultRaw
        ? new Set(resultRaw.split(',').map((s) => s.trim()).filter(Boolean))
        : null;

      // Full-log summary (computed BEFORE filtering so totals are always true)
      let totalImprovements = 0;
      let scoreDeltaSum = 0;
      let scoreDeltaCount = 0;
      const byPattern: Record<string, { count: number; successes: number; avgDelta: number }> = {};
      for (const e of entries) {
        if (e.result === 'success') totalImprovements++;
        if (typeof e.scoreBefore === 'number' && typeof e.scoreAfter === 'number') {
          const d = e.scoreAfter - e.scoreBefore;
          scoreDeltaSum += d;
          scoreDeltaCount++;
        }
        const action = e.action || 'unknown';
        if (!byPattern[action]) byPattern[action] = { count: 0, successes: 0, avgDelta: 0 };
        byPattern[action].count++;
        if (e.result === 'success') byPattern[action].successes++;
        if (typeof e.scoreBefore === 'number' && typeof e.scoreAfter === 'number') {
          byPattern[action].avgDelta += e.scoreAfter - e.scoreBefore;
        }
      }
      for (const k of Object.keys(byPattern)) {
        const bp = byPattern[k];
        if (bp && bp.count > 0) bp.avgDelta = Math.round((bp.avgDelta / bp.count) * 100) / 100;
      }

      // Apply filters (newest first), then cap
      const filtered = entries
        .filter((e) => {
          if (patternSet && !patternSet.has(e.action)) return false;
          if (resultSet && !resultSet.has(e.result)) return false;
          if (Number.isFinite(sinceMs)) {
            const t = Date.parse(e.date);
            if (!Number.isFinite(t) || t <= sinceMs) return false;
          }
          return true;
        })
        .slice()
        .reverse()
        .slice(0, limit);

      res.json({
        experiments: filtered,
        learnedPatterns: log.learnedPatterns ?? [],
        summary: {
          totalRuns: entries.length,
          totalImprovements,
          avgScoreDelta: scoreDeltaCount > 0
            ? Math.round((scoreDeltaSum / scoreDeltaCount) * 100) / 100
            : 0,
          cumulativeScoreDelta: Math.round(scoreDeltaSum * 100) / 100,
          byPattern,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/observer/experiments/:id — single experiment detail.
  //   Enriches the record with the most recent observer report that contains
  //   the targeted page so the UI can render per-page issues / score context.
  app.get('/api/observer/experiments/:id', async (req, res) => {
    try {
      const id = req.params['id'];
      if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
      const { readExperimentLog, listObserverReports, readObserverReport } = await import('../core/observer.js');
      const log = readExperimentLog(vaultRoot);
      const entry = (log.entries ?? []).find((e) => e.id === id);
      if (!entry) { res.status(404).json({ error: `No experiment ${id}` }); return; }

      // Try to enrich with the nearest report (newest first). If the target is
      // 'wiki-wide' there's no per-page score to attach.
      let pageContext: unknown = null;
      let reportDate: string | undefined;
      if (entry.target && entry.target !== 'wiki-wide') {
        const reports = listObserverReports(vaultRoot);
        for (const f of reports) {
          const date = f.replace(/\.json$/, '');
          const rep = readObserverReport(vaultRoot, date);
          if (!rep) continue;
          const match = rep.scores.find((s) => s.page === entry.target);
          if (match) {
            pageContext = match;
            reportDate = date;
            break;
          }
        }
      }

      const scoreDelta = typeof entry.scoreBefore === 'number' && typeof entry.scoreAfter === 'number'
        ? entry.scoreAfter - entry.scoreBefore
        : null;

      res.json({
        experiment: { ...entry, scoreDelta },
        pageContext,
        reportDate,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/observer/run/stream — SSE endpoint that triggers a manual observer
  // run and streams progress events. The existing POST /api/observer/run route
  // remains the canonical way to trigger a run when the client doesn't care
  // about live progress.
  app.get('/api/observer/run/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const autoImprove = String(req.query['autoImprove'] ?? '') === 'true';
    const maxImprovements = Number(req.query['maxImprovements']);
    const maxBudget = Number(req.query['maxBudget']);

    send('status', { phase: 'starting', message: 'Observer starting…', ts: Date.now() });

    // Heartbeat so the connection doesn't idle out behind proxies.
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* client gone */ }
    }, 10_000);

    try {
      send('status', { phase: 'scanning', message: 'Scoring pages and scanning for patterns…', ts: Date.now() });
      const { runObserver } = await import('../core/observer.js');
      const report = await runObserver(config, {
        autoImprove,
        maxImprovements: Number.isFinite(maxImprovements) ? maxImprovements : undefined,
        maxBudget: Number.isFinite(maxBudget) ? maxBudget : undefined,
      });

      send('status', { phase: 'summarizing', message: `Analyzed ${report.pagesReviewed}/${report.totalPages} pages.`, ts: Date.now() });

      send('complete', {
        date: report.date,
        totalPages: report.totalPages,
        pagesReviewed: report.pagesReviewed,
        averageScore: report.averageScore,
        maxScore: report.maxScore,
        orphanCount: report.orphans.length,
        gapCount: report.gaps.length,
        contradictionCount: report.contradictions.length,
        improvementCount: report.improvements?.length ?? 0,
        discoveryCount: report.unexpectedPatterns?.length ?? 0,
        crossLinkCount: report.crossLinks?.length ?? 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send('error', { message: msg });
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* already closed */ }
    }
  });

  // ─── Lint / Health Check ──────────────────────────────────────────────────

  // POST /api/lint — run wiki lint check (includes contradiction detection)
  app.post('/api/lint', async (_req, res) => {
    try {
      const { lintWiki } = await import('../core/lint.js');
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);
      const result = await lintWiki(config, provider, { fix: false });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/contradictions — get detected contradictions with page content for side-by-side diff
  app.get('/api/contradictions', async (_req, res) => {
    try {
      const { flagContradictions } = await import('../core/observer.js');
      const pages = listWikiPages(config.wikiDir);
      const contradictions = flagContradictions(pages);
      // Enrich with page content for side-by-side display
      const enriched = contradictions.map(c => {
        const pageA = readWikiPage(c.pageA);
        const pageB = readWikiPage(c.pageB);
        return {
          ...c,
          summaryA: String(pageA.frontmatter['summary'] ?? '').slice(0, 500),
          summaryB: String(pageB.frontmatter['summary'] ?? '').slice(0, 500),
          contentSnippetA: pageA.content.slice(0, 300),
          contentSnippetB: pageB.content.slice(0, 300),
        };
      });
      res.json({ contradictions: enriched, count: enriched.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/contradictions/resolve — resolve a detected contradiction
  app.post('/api/contradictions/resolve', async (req, res) => {
    try {
      const { pageAPath, pageBPath, resolution, reason } = req.body as {
        pageAPath: string;
        pageBPath: string;
        resolution: 'keep-a' | 'keep-b' | 'merge' | 'dismiss';
        reason?: string;
      };
      if (!pageAPath || !pageBPath || !resolution) {
        res.status(400).json({ error: 'Missing pageAPath, pageBPath, or resolution' });
        return;
      }

      const { readFileSync, writeFileSync } = await import('node:fs');
      const matter = (await import('gray-matter')).default;
      const { basename } = await import('node:path');

      // Read both pages
      const rawA = readFileSync(pageAPath, 'utf-8');
      const rawB = readFileSync(pageBPath, 'utf-8');
      const parsedA = matter(rawA);
      const parsedB = matter(rawB);

      const now = new Date().toISOString().split('T')[0] ?? '';
      const entry = {
        date: now,
        resolution,
        opposing_page: '',
        reason: reason ?? '',
      };

      // Add conflicts_resolved to the page that "won" or both for merge/dismiss
      if (resolution === 'keep-a' || resolution === 'merge' || resolution === 'dismiss') {
        const existing = Array.isArray(parsedA.data['conflicts_resolved'])
          ? (parsedA.data['conflicts_resolved'] as unknown[])
          : [];
        entry.opposing_page = basename(pageBPath, '.md');
        existing.push({ ...entry });
        parsedA.data['conflicts_resolved'] = existing;
        parsedA.data['updated'] = now;
        writeFileSync(pageAPath, matter.stringify(parsedA.content, parsedA.data), 'utf-8');
      }

      if (resolution === 'keep-b' || resolution === 'merge' || resolution === 'dismiss') {
        const existing = Array.isArray(parsedB.data['conflicts_resolved'])
          ? (parsedB.data['conflicts_resolved'] as unknown[])
          : [];
        entry.opposing_page = basename(pageAPath, '.md');
        existing.push({ ...entry });
        parsedB.data['conflicts_resolved'] = existing;
        parsedB.data['updated'] = now;
        writeFileSync(pageBPath, matter.stringify(parsedB.content, parsedB.data), 'utf-8');
      }

      // Auto-commit the resolution
      try {
        const { autoCommit, isGitRepo } = await import('../core/git.js');
        if (await isGitRepo(vaultRoot)) {
          const titleA = String(parsedA.data['title'] ?? basename(pageAPath, '.md'));
          const titleB = String(parsedB.data['title'] ?? basename(pageBPath, '.md'));
          await autoCommit(
            vaultRoot,
            'resolve',
            `conflict between "${titleA}" and "${titleB}" → ${resolution}`,
            reason ?? '',
          );
        }
      } catch { /* non-fatal */ }

      // Audit trail
      try {
        const { appendAuditEntry } = await import('../core/audit-trail.js');
        appendAuditEntry(vaultRoot, {
          action: 'edit',
          actor: 'human',
          summary: `Resolved conflict: ${resolution} (${basename(pageAPath, '.md')} vs ${basename(pageBPath, '.md')})${reason ? ': ' + reason : ''}`,
          pagesAffected: [basename(pageAPath, '.md'), basename(pageBPath, '.md')],
        });
      } catch { /* non-fatal */ }

      res.json({ success: true, resolution });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Automations: Scrape ──────────────────────────────────────────────────

  // POST /api/automations/scrape — trigger scrape for a source (or all)
  app.post('/api/automations/scrape', async (req, res) => {
    try {
      const { source: sourceName, dryRun, maxItems } = req.body as {
        source?: string;
        dryRun?: boolean;
        maxItems?: number;
      };
      const { runSmartScraper } = await import('../core/scraper.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const result = await runSmartScraper(
        config,
        userConfig,
        { dryRun: dryRun ?? false, maxItems: maxItems ?? 10 },
        sourceName,
      );
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Scrape failed: ${msg}` });
    }
  });

  // POST /api/automations/observe — trigger observer with optional budget
  app.post('/api/automations/observe', async (req, res) => {
    try {
      const { maxPagesToReview, maxCostEstimate } = req.body as {
        maxPagesToReview?: number;
        maxCostEstimate?: number;
      };
      void maxCostEstimate;
      const { runObserver } = await import('../core/observer.js');
      const report = await runObserver(config, { maxPagesToReview });
      res.json({
        success: true,
        date: report.date,
        totalPages: report.totalPages,
        pagesReviewed: report.pagesReviewed,
        averageScore: report.averageScore,
        maxScore: report.maxScore,
        orphanCount: report.orphans.length,
        gapCount: report.gaps.length,
        contradictionCount: report.contradictions.length,
        reportPath: `.wikimem/observer-reports/${report.date}.json`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Observer run failed: ${msg}` });
    }
  });

  // GET /api/automations/status — status of all three automations
  app.get('/api/automations/status', async (_req, res) => {
    try {
      const { readAuditTrail } = await import('../core/audit-trail.js');
      const { isObserverCronRunning } = await import('../core/observer.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const settings = loadAutomationSettings();

      const recentIngest = readAuditTrail(vaultRoot, 1, undefined, 'ingest');
      const recentScrape = readAuditTrail(vaultRoot, 1, undefined, 'scrape');
      const recentObserve = readAuditTrail(vaultRoot, 1, undefined, 'observe');

      res.json({
        ingest: {
          enabled: settings['ingest']?.['enabled'] !== false,
          lastRun: recentIngest[0]?.timestamp ?? null,
          watcherActive: true,
        },
        scrape: {
          enabled: settings['scrape']?.['enabled'] !== false,
          lastRun: recentScrape[0]?.timestamp ?? null,
          sourcesConfigured: (userConfig.sources ?? []).length,
        },
        observe: {
          enabled: settings['observe']?.['enabled'] !== false,
          lastRun: recentObserve[0]?.timestamp ?? null,
          cronActive: isObserverCronRunning(),
          schedule: '0 3 * * *',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get automation status: ${msg}` });
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
        type: string;
        name?: string;
        path?: string;
        url?: string;
        includeGlobs?: string[];
        excludeGlobs?: string[];
        autoSync?: boolean;
        syncSchedule?: string;
        topics?: string[];
      };

      if (!body.type) { res.status(400).json({ error: 'Missing type' }); return; }

      let resolvedPath = body.path || '';

      // RSS and Notion connectors don't need a filesystem path
      if (body.type === 'rss' || body.type === 'notion') {
        if (!body.url && body.type === 'rss') {
          res.status(400).json({ error: 'RSS connector requires a feed URL' }); return;
        }
        resolvedPath = resolvedPath || join(vaultRoot, 'raw');
        mkdirSync(resolvedPath, { recursive: true });
      } else if (body.type === 'github' || (body.type === 'git-repo' && body.url)) {
        // For git repos, clone if URL provided
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
        type: body.type as 'folder' | 'git-repo' | 'github' | 'slack' | 'linear' | 'jira' | 'gmail' | 'gdrive' | 'notion' | 'rss',
        name: body.name || (body.type === 'rss' ? (body.url ?? 'RSS Feed') : basename(resolvedPath)),
        path: resolvedPath,
        url: body.url,
        includeGlobs: body.includeGlobs,
        excludeGlobs: body.excludeGlobs,
        autoSync: body.autoSync ?? false,
        syncSchedule: body.syncSchedule,
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

      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);

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

  // ─── Platform Sync APIs ──────────────────────────────────────────────────

  // Shared scheduler singleton — reused across routes and startup
  let syncScheduler: import('../core/sync/index.js').SyncScheduler | null = null;
  async function getSyncScheduler(): Promise<import('../core/sync/index.js').SyncScheduler> {
    if (!syncScheduler) {
      const { SyncScheduler } = await import('../core/sync/index.js');
      syncScheduler = new SyncScheduler(vaultRoot);
    }
    return syncScheduler;
  }

  // IMPORTANT: Specific routes MUST be registered before the generic :provider route
  // to avoid Express matching "rss" or "schedules" as a provider name.

  // GET /api/sync/schedules — list all active sync schedules
  app.get('/api/sync/schedules', async (_req, res) => {
    try {
      const scheduler = await getSyncScheduler();
      res.json({ schedules: scheduler.getSchedules() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/sync/rss/:connectorId — trigger RSS feed sync for a specific connector
  app.post('/api/sync/rss/:connectorId', async (req, res) => {
    try {
      const connectorId = req.params['connectorId'];
      if (!connectorId) { res.status(400).json({ error: 'Missing connectorId' }); return; }
      const { syncRssConnector } = await import('../core/sync/index.js');
      const result = await syncRssConnector(connectorId, vaultRoot);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `RSS sync failed: ${msg}` });
    }
  });

  // POST /api/sync/:provider/schedule — set sync schedule for a provider
  app.post('/api/sync/:provider/schedule', async (req, res) => {
    try {
      const provider = req.params['provider'];
      const { schedule } = req.body as { schedule?: string };
      if (!provider || !schedule) { res.status(400).json({ error: 'Missing provider or schedule' }); return; }
      const scheduler = await getSyncScheduler();
      scheduler.schedule(provider, schedule);
      res.json({ status: 'scheduled', provider, schedule });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/sync/:provider — trigger sync for a connected OAuth provider
  // Accepts optional filter parameters in the request body:
  //   maxItems, since, query, preview, channels, labels, repos, projectKeys, databaseIds, folderId, topics
  // MUST be last among /api/sync/* routes (generic :provider catches everything)
  app.post('/api/sync/:provider', async (req, res) => {
    try {
      const provider = req.params['provider'];
      if (!provider) { res.status(400).json({ error: 'Missing provider' }); return; }

      // Extract filter parameters from request body
      const body = req.body as Record<string, unknown> | undefined;
      const filters: import('../core/sync/sync-filters.js').SyncFilters = {};
      if (body) {
        if (typeof body['maxItems'] === 'number') filters.maxItems = body['maxItems'];
        if (typeof body['since'] === 'string') filters.since = body['since'];
        if (typeof body['query'] === 'string') filters.query = body['query'];
        if (typeof body['preview'] === 'boolean') filters.preview = body['preview'];
        if (Array.isArray(body['channels'])) filters.channels = body['channels'] as string[];
        if (Array.isArray(body['labels'])) filters.labels = body['labels'] as string[];
        if (Array.isArray(body['repos'])) filters.repos = body['repos'] as string[];
        if (Array.isArray(body['projectKeys'])) filters.projectKeys = body['projectKeys'] as string[];
        if (Array.isArray(body['databaseIds'])) filters.databaseIds = body['databaseIds'] as string[];
        if (typeof body['folderId'] === 'string') filters.folderId = body['folderId'];
        if (Array.isArray(body['topics'])) filters.topics = body['topics'] as string[];
      }

      const hasFilters = Object.keys(filters).length > 0;
      const { syncProvider } = await import('../core/sync/index.js');
      const result = await syncProvider(provider, vaultRoot, hasFilters ? filters : undefined);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Sync failed: ${msg}` });
    }
  });

  // GET /api/connectors/:id/preview — preview what would be synced for a provider
  // Query params: maxItems, since, query, channels, labels, repos, projectKeys, databaseIds, folderId, topics
  app.get('/api/connectors/:id/preview', async (req, res) => {
    try {
      const provider = req.params['id'];
      if (!provider) { res.status(400).json({ error: 'Missing provider id' }); return; }

      // Extract filter parameters from query string
      const q = req.query;
      const filters: import('../core/sync/sync-filters.js').SyncFilters = {};
      if (q['maxItems']) filters.maxItems = parseInt(q['maxItems'] as string, 10);
      if (q['since']) filters.since = q['since'] as string;
      if (q['query']) filters.query = q['query'] as string;
      if (q['channels']) filters.channels = (q['channels'] as string).split(',');
      if (q['labels']) filters.labels = (q['labels'] as string).split(',');
      if (q['repos']) filters.repos = (q['repos'] as string).split(',');
      if (q['projectKeys']) filters.projectKeys = (q['projectKeys'] as string).split(',');
      if (q['databaseIds']) filters.databaseIds = (q['databaseIds'] as string).split(',');
      if (q['folderId']) filters.folderId = q['folderId'] as string;
      if (q['topics']) filters.topics = (q['topics'] as string).split(',');

      const { previewProvider } = await import('../core/sync/index.js');
      const preview = await previewProvider(provider, vaultRoot, filters);
      res.json(preview);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Preview failed: ${msg}` });
    }
  });

  // ─── Enhanced Webhooks ──────────────────────────────────────────────────

  // POST /api/webhook/github — receive GitHub push/issue/PR webhooks
  app.post('/api/webhook/github', async (req, res) => {
    try {
      const { parseGitHubWebhook, webhookToMarkdown } = await import('../core/webhooks.js');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const payload = parseGitHubWebhook(headers, req.body);
      if (!payload) { res.status(200).json({ status: 'ignored' }); return; }

      const markdown = webhookToMarkdown(payload);
      const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
      const { join: joinPath } = await import('node:path');
      const { slugify } = await import('../core/vault.js');
      const now = new Date().toISOString().split('T')[0] ?? '';
      const dateDir = joinPath(config.rawDir, now);
      mkdir(dateDir, { recursive: true });
      const filePath = joinPath(dateDir, `github-${payload.event}-${slugify(payload.title.substring(0, 40))}.md`);
      write(filePath, markdown, 'utf-8');

      res.json({ status: 'received', event: payload.event, title: payload.title });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/webhook/slack — receive Slack events and slash commands
  app.post('/api/webhook/slack', async (req, res) => {
    try {
      const { parseSlackWebhook, webhookToMarkdown } = await import('../core/webhooks.js');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const payload = parseSlackWebhook(headers, req.body);
      if (!payload) { res.status(200).json({ status: 'ignored' }); return; }

      // Handle Slack URL verification challenge
      if (payload.event === 'url_verification') {
        res.json({ challenge: payload.content });
        return;
      }

      const markdown = webhookToMarkdown(payload);
      const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
      const { join: joinPath } = await import('node:path');
      const { slugify } = await import('../core/vault.js');
      const now = new Date().toISOString().split('T')[0] ?? '';
      const dateDir = joinPath(config.rawDir, now);
      mkdir(dateDir, { recursive: true });
      const filePath = joinPath(dateDir, `slack-${payload.event}-${slugify(payload.title.substring(0, 40))}.md`);
      write(filePath, markdown, 'utf-8');

      res.json({ status: 'received', event: payload.event, title: payload.title });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Automation Scheduler (central manager for all 3 automations) ────────

  // Lazy-import the scheduler (createServer is sync, scheduler is async-loaded)
  const schedulerMod = import('../core/scheduler.js');
  let _scheduler: Awaited<typeof schedulerMod> | undefined;
  let _automationScheduler: ReturnType<Awaited<typeof schedulerMod>['getAutomationScheduler']> | undefined;
  const getScheduler = async () => {
    if (!_scheduler) _scheduler = await schedulerMod;
    if (!_automationScheduler) _automationScheduler = _scheduler.getAutomationScheduler(config);
    return { mod: _scheduler, scheduler: _automationScheduler };
  };
  // Eagerly kick off the import
  const schedulerReady = getScheduler();
  // Convenience aliases used by routes below
  type SchedulerType = ReturnType<Awaited<typeof schedulerMod>['getAutomationScheduler']>;
  const automationScheduler = {
    on: (...a: Parameters<SchedulerType['on']>) => { void schedulerReady.then(s => s.scheduler.on(...a)); },
    off: (...a: Parameters<SchedulerType['off']>) => { void schedulerReady.then(s => s.scheduler.off(...a)); },
    getAll: () => _automationScheduler?.getAll() ?? [],
    getOne: (id: Parameters<SchedulerType['getOne']>[0]) => _automationScheduler?.getOne(id) ?? undefined,
    update: (id: Parameters<SchedulerType['update']>[0], opts: Parameters<SchedulerType['update']>[1]) => _automationScheduler?.update(id, opts) ?? undefined,
    triggerRun: async (id: Parameters<SchedulerType['triggerRun']>[0]) => { const s = await getScheduler(); return s.scheduler.triggerRun(id); },
    getRunLogs: (id: Parameters<SchedulerType['getRunLogs']>[0], limit?: number) => _automationScheduler?.getRunLogs(id, limit) ?? [],
    startAll: () => _automationScheduler?.startAll(),
    stopAll: () => _automationScheduler?.stopAll(),
  };
  const isValidAutomationId = (id: string) => _scheduler?.isValidAutomationId(id) ?? false;

  // SSE endpoint for automation status changes
  app.get('/api/automations/events', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');

    const onEvent = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    automationScheduler.on('automation-event', onEvent);
    _req.on('close', () => automationScheduler.off('automation-event', onEvent));
  });

  // GET /api/automations — list all automations with status, schedule, last run
  app.get('/api/automations', (_req, res) => {
    try {
      const automations = automationScheduler.getAll();
      res.json({ automations });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list automations: ${msg}` });
    }
  });

  // GET /api/automations/:id — get one automation's state
  app.get('/api/automations/:id', (req, res) => {
    try {
      const id = req.params['id'] ?? '';
      if (!isValidAutomationId(id)) {
        res.status(404).json({ error: `Unknown automation: ${id}` });
        return;
      }
      const state = automationScheduler.getOne(id as import('../core/scheduler.js').AutomationId);
      if (!state) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // PUT /api/automations/:id — update schedule, enable/disable
  app.put('/api/automations/:id', (req, res) => {
    try {
      const id = req.params['id'] ?? '';
      if (!isValidAutomationId(id)) {
        res.status(404).json({ error: `Unknown automation: ${id}` });
        return;
      }
      const { schedule, schedulePreset, enabled } = req.body as {
        schedule?: string;
        schedulePreset?: string;
        enabled?: boolean;
      };
      const updated = automationScheduler.update(id as import('../core/scheduler.js').AutomationId, {
        schedule,
        schedulePreset: schedulePreset as import('../core/scheduler.js').SchedulePreset | undefined,
        enabled,
      });
      if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/automations/:id/run — trigger a manual run
  app.post('/api/automations/:id/run', async (req, res) => {
    try {
      const id = req.params['id'] ?? '';
      if (!isValidAutomationId(id)) {
        res.status(404).json({ error: `Unknown automation: ${id}` });
        return;
      }
      const log = await automationScheduler.triggerRun(id as import('../core/scheduler.js').AutomationId);
      res.json(log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/automations/:id/log — get run history
  app.get('/api/automations/:id/log', (req, res) => {
    try {
      const id = req.params['id'] ?? '';
      if (!isValidAutomationId(id)) {
        res.status(404).json({ error: `Unknown automation: ${id}` });
        return;
      }
      const limit = parseInt(req.query['limit'] as string) || 50;
      const logs = automationScheduler.getRunLogs(id as import('../core/scheduler.js').AutomationId, limit);
      res.json({ logs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Start SyncScheduler for connected providers (reuses singleton from routes)
  getSyncScheduler().then((scheduler) => {
    scheduler.startFromConfig();
    scheduler.on('sync-complete', (result: { provider: string; filesWritten: number }) => {
      console.log(`[sync] ${result.provider}: ${result.filesWritten} files synced`);
    });
  }).catch(() => {});

  // Wire file-detected events from connectors to auto-ingest
  (async () => {
    const { getConnectorManager } = await import('../core/connectors.js');
    const { ingestSource } = await import('../core/ingest.js');
    const { createProviderFromUserConfig } = await import('../providers/index.js');
    const { loadConfig } = await import('../core/config.js');
    const mgr = getConnectorManager(vaultRoot);
    mgr.on('file-detected', async ({ connectorId, filePath }: { connectorId: string; filePath: string }) => {
      const connector = mgr.get(connectorId);
      if (!connector) return;
      mgr.updateStatus(connectorId, 'syncing');
      try {
        const userConfig = loadConfig(config.configPath);
        const provider = createProviderFromUserConfig(userConfig);
        await ingestSource(filePath, config, provider, { verbose: false });
        mgr.updateStatus(connectorId, 'active', { lastSyncAt: new Date().toISOString() });
      } catch {
        mgr.updateStatus(connectorId, 'error', { errorMessage: `Failed to ingest ${basename(filePath)}` });
      }
    });
    mgr.startAllWatchers();
  })().catch(() => {});

  // Start central automation scheduler (observer cron + pipeline watcher)
  automationScheduler.startAll();

  // ── UXO-038: Bookmark API ──────────────────────────────────────────────────
  function getBookmarkStorePath(): string {
    return join(vaultRoot, '.wikimem', 'bookmarks.json');
  }
  function loadBookmarks(): string[] {
    const p = getBookmarkStorePath();
    if (!existsSync(p)) return [];
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  function saveBookmarksFile(titles: string[]): void {
    const p = getBookmarkStorePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(titles, null, 2), 'utf-8');
  }

  app.get('/api/bookmarks', (_req, res) => {
    try {
      res.json({ pages: loadBookmarks() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/bookmarks/:title', (req, res) => {
    try {
      const title = decodeURIComponent(req.params['title'] ?? '');
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }
      const list = loadBookmarks();
      if (!list.includes(title)) {
        list.push(title);
        saveBookmarksFile(list);
      }
      res.json({ pages: list });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.delete('/api/bookmarks/:title', (req, res) => {
    try {
      const title = decodeURIComponent(req.params['title'] ?? '');
      if (!title) { res.status(400).json({ error: 'Missing title' }); return; }
      const list = loadBookmarks().filter((t) => t !== title);
      saveBookmarksFile(list);
      res.json({ pages: list });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── UXO-039: Metadata schema endpoint ────────────────────────────────────
  app.get('/api/metadata/schema', (_req, res) => {
    try {
      const STANDARD_FIELDS = ['category', 'tags', 'created', 'sources', 'related'];
      const fieldSet = new Set<string>();
      const pages = listWikiPages(config.wikiDir);
      for (const p of pages) {
        try {
          const page = readWikiPage(p);
          const fm = page.frontmatter as Record<string, unknown>;
          // Normalize before collecting
          if ('createdAt' in fm && !('created' in fm)) { fm['created'] = fm['createdAt']; delete fm['createdAt']; }
          if ('created_at' in fm && !('created' in fm)) { fm['created'] = fm['created_at']; delete fm['created_at']; }
          if ('type' in fm && !('category' in fm)) { fm['category'] = fm['type']; delete fm['type']; }
          for (const key of Object.keys(fm)) {
            if (key !== 'title') fieldSet.add(key);
          }
        } catch { /* skip unreadable pages */ }
      }
      const allFields = Array.from(fieldSet);
      const standard = STANDARD_FIELDS.filter((f) => allFields.includes(f));
      const custom = allFields.filter((f) => !STANDARD_FIELDS.includes(f));
      res.json({ fields: [...standard, ...custom], standard, custom });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Privacy API ───────────────────────────────────────────────────────────

  // GET /api/privacy/accepted — check if first-run privacy notice was accepted
  app.get('/api/privacy/accepted', (_req, res) => {
    try {
      const accepted = isPrivacyAccepted(vaultRoot);
      res.json({ accepted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/privacy/accept — record user acceptance of the privacy notice
  app.post('/api/privacy/accept', (_req, res) => {
    try {
      markPrivacyAccepted(vaultRoot);
      res.json({ accepted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // DELETE /api/privacy/data — delete ALL vault data (with confirmation token)
  // Requires body: { confirm: "DELETE ALL DATA" }
  app.delete('/api/privacy/data', (req, res) => {
    try {
      const body = req.body as { confirm?: string };
      if (body.confirm !== 'DELETE ALL DATA') {
        res.status(400).json({ error: 'Must include { confirm: "DELETE ALL DATA" } in request body' });
        return;
      }
      const deleted = deleteAllVaultData(vaultRoot);
      res.json({ deleted, count: deleted.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // === AGENTDIAL WEBHOOK ENDPOINTS ===
  // Gives wikimem an agent identity on Slack and Email via AgentDial.
  // These endpoints accept webhook payloads and route to the ingest/query pipeline.
  // They do NOT call out to Slack/AgentMail APIs — callers (AgentDial gateway) do that.

  // POST /api/agentdial/email — AgentMail webhook: ingest email body as wiki knowledge
  // Expected payload: { subject, body, from, attachments?: [{ name, content, contentType }] }
  // Response: { ingested: true, title, summary, sources }
  app.post('/api/agentdial/email', async (req, res) => {
    try {
      const { subject, body, from, attachments } = req.body as {
        subject?: string;
        body?: string;
        from?: string;
        attachments?: Array<{ name: string; content: string; contentType?: string }>;
      };

      if (!body && (!attachments || attachments.length === 0)) {
        res.status(400).json({ error: 'Missing body or attachments' });
        return;
      }

      const { ingestSource } = await import('../core/ingest.js');
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);

      const ingestResults: Array<{ title: string; pagesUpdated: number }> = [];

      // Ingest email body as plain text
      if (body && body.trim().length > 0) {
        const { join: pathJoin } = await import('node:path');
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { randomBytes } = await import('node:crypto');

        // Write body to a temp file and ingest it
        const tmpDir = pathJoin(config.rawDir, '_agentdial_tmp');
        mkdirSync(tmpDir, { recursive: true });
        const slug = (subject ?? 'email').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
        const tmpFile = pathJoin(tmpDir, `${slug}-${randomBytes(4).toString('hex')}.txt`);
        const content = subject ? `# ${subject}\n\nFrom: ${from ?? 'unknown'}\n\n${body}` : body;
        writeFileSync(tmpFile, content, 'utf-8');

        const result = await ingestSource(tmpFile, config, provider, {
          verbose: false,
          addedBy: 'webhook',
          tags: ['email', 'agentdial'],
          metadata: { source_email: from ?? '', original_subject: subject ?? '' },
        });
        ingestResults.push({ title: result.title, pagesUpdated: result.pagesUpdated });
      }

      // Ingest any text/plain or text/html attachments
      if (attachments && attachments.length > 0) {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join: pathJoin } = await import('node:path');
        const { randomBytes } = await import('node:crypto');
        const tmpDir = pathJoin(config.rawDir, '_agentdial_tmp');
        mkdirSync(tmpDir, { recursive: true });

        for (const att of attachments) {
          const isText = !att.contentType || att.contentType.startsWith('text/');
          if (!isText) continue;
          const tmpFile = pathJoin(tmpDir, `${att.name}-${randomBytes(4).toString('hex')}.txt`);
          writeFileSync(tmpFile, att.content, 'utf-8');
          const result = await ingestSource(tmpFile, config, provider, {
            verbose: false,
            addedBy: 'webhook',
            tags: ['email', 'attachment', 'agentdial'],
          });
          ingestResults.push({ title: result.title, pagesUpdated: result.pagesUpdated });
        }
      }

      const totalPages = ingestResults.reduce((sum, r) => sum + r.pagesUpdated, 0);
      const titles = ingestResults.map((r) => r.title);

      // Build a plain-text reply suitable for AgentDial to forward back to sender
      const replyText = ingestResults.length === 0
        ? 'Nothing ingested — email had no text body or text attachments.'
        : `Ingested into your wiki:\n${titles.map((t) => `- ${t}`).join('\n')}\n\n${totalPages} page${totalPages !== 1 ? 's' : ''} updated.`;

      res.json({
        ingested: ingestResults.length > 0,
        titles,
        pagesUpdated: totalPages,
        reply: replyText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `AgentDial email ingest failed: ${msg}` });
    }
  });

  // POST /api/agentdial/slack — Slack event webhook: answer questions via wiki query
  // Expected payload: { event: { type, text, user, channel, ts } } (Slack Events API shape)
  // Also accepts flat shape: { text, user, channel }
  // Response: { answer, sources, reply } — caller (AgentDial gateway) posts reply to Slack
  app.post('/api/agentdial/slack', async (req, res) => {
    try {
      // Support both Slack Events API envelope and flat shape
      const body = req.body as {
        type?: string;
        challenge?: string;
        event?: { type?: string; text?: string; user?: string; channel?: string; ts?: string };
        text?: string;
        user?: string;
        channel?: string;
      };

      // Slack URL verification handshake
      if (body.type === 'url_verification' && body.challenge) {
        res.json({ challenge: body.challenge });
        return;
      }

      const rawText = (body.event?.text ?? body.text ?? '').trim();
      const channel = body.event?.channel ?? body.channel ?? '';

      if (!rawText) {
        res.status(400).json({ error: 'Missing text field' });
        return;
      }

      // Strip @mention prefix if present (e.g. "<@U12345> what is X?" → "what is X?")
      const question = rawText.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
      if (!question) {
        res.status(400).json({ error: 'Question is empty after stripping mention' });
        return;
      }

      const { queryWiki } = await import('../core/query.js');
      const { createProviderFromUserConfig } = await import('../providers/index.js');
      const { loadConfig } = await import('../core/config.js');
      const userConfig = loadConfig(config.configPath);
      const provider = createProviderFromUserConfig(userConfig);

      const result = await queryWiki(question, config, provider, { fileBack: false });

      // Format Slack-friendly reply with source links
      const sourceList = result.sourcesConsulted.length > 0
        ? `\n\nSources: ${result.sourcesConsulted.map((s) => `*${s}*`).join(', ')}`
        : '';
      const replyText = `${result.answer}${sourceList}`;

      res.json({
        answer: result.answer,
        sources: result.sourcesConsulted,
        channel,
        reply: replyText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `AgentDial Slack query failed: ${msg}` });
    }
  });

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

  // Security: bind to 127.0.0.1 only — prevents other hosts on the network from
  // overwriting tokens via POST /api/auth/tokens/:provider (no auth check there).
  app.listen(port, '127.0.0.1', () => {
    console.log(`\n  wikimem web UI running at http://localhost:${port}`);
    console.log(`  Vault: ${vaultRoot}\n`);
  });
}

