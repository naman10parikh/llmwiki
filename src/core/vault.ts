import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import matter from 'gray-matter';

export interface WikiPage {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  wordCount: number;
}

export interface VaultStats {
  pageCount: number;
  wordCount: number;
  sourceCount: number;
  wikilinks: number;
  orphanPages: number;
  lastUpdated: string;
}

export interface VaultConfig {
  root: string;
  rawDir: string;
  wikiDir: string;
  schemaPath: string;
  indexPath: string;
  logPath: string;
  configPath: string;
}

export function getVaultConfig(root: string): VaultConfig {
  return {
    root,
    rawDir: join(root, 'raw'),
    wikiDir: join(root, 'wiki'),
    schemaPath: join(root, 'AGENTS.md'),
    indexPath: join(root, 'wiki', 'index.md'),
    logPath: join(root, 'wiki', 'log.md'),
    configPath: join(root, 'config.yaml'),
  };
}

export function ensureVaultDirs(config: VaultConfig): void {
  const dirs = [config.rawDir, config.wikiDir];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function readWikiPage(filePath: string): WikiPage {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const wikilinks = extractWikilinks(content);
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const title = (data['title'] as string) ?? basename(filePath, extname(filePath));

  return {
    path: filePath,
    title,
    content,
    frontmatter: data,
    wikilinks,
    wordCount,
  };
}

export function writeWikiPage(
  filePath: string,
  content: string,
  frontmatter: Record<string, unknown>,
): void {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const output = matter.stringify(content, frontmatter);
  writeFileSync(filePath, output, 'utf-8');
}

/** Version entry stored in .wikimem/versions/<slug>.versions.json */
export interface PageVersion {
  version: number;
  timestamp: string;
  content: string;
  frontmatter: Record<string, unknown>;
  source?: string;
  actor?: string;
}

/**
 * Write a wiki page with temporal versioning (COMP-MP-002 + COMP-MP-005).
 * - Adds `learned_at`, `fact_version`, `ingest_session` to frontmatter
 * - If the page already exists, archives the previous version to .wikimem/versions/
 * - Maintains `previous_versions` count in frontmatter
 */
export function writeWikiPageVersioned(
  filePath: string,
  content: string,
  frontmatter: Record<string, unknown>,
  vaultRoot: string,
  options?: { source?: string; actor?: string; sessionId?: string },
): void {
  const now = new Date().toISOString();
  const slug = basename(filePath, extname(filePath));
  const versionsDir = join(vaultRoot, '.wikimem', 'versions');
  const versionsFile = join(versionsDir, `${slug}.versions.json`);

  // Load existing versions
  let versions: PageVersion[] = [];
  if (existsSync(versionsFile)) {
    try {
      versions = JSON.parse(readFileSync(versionsFile, 'utf-8')) as PageVersion[];
    } catch { /* corrupted file — start fresh */ }
  }

  // If the page already exists, archive the current content as a version
  if (existsSync(filePath)) {
    try {
      const existing = readWikiPage(filePath);
      versions.push({
        version: versions.length + 1,
        timestamp: (existing.frontmatter['updated'] as string) ?? (existing.frontmatter['learned_at'] as string) ?? now,
        content: existing.content,
        frontmatter: existing.frontmatter,
        source: (existing.frontmatter['sources'] as string[])?.[0],
        actor: (existing.frontmatter['added_by'] as string) ?? 'unknown',
      });
    } catch { /* file exists but unreadable — skip archival */ }
  }

  const newVersion = versions.length + 1;

  // Enrich frontmatter with temporal fields
  frontmatter['learned_at'] = now;
  frontmatter['fact_version'] = newVersion;
  frontmatter['previous_versions'] = versions.length;
  if (options?.sessionId) {
    frontmatter['ingest_session'] = options.sessionId;
  }
  if (options?.actor) {
    frontmatter['added_by'] = options.actor;
  }

  // Write the page
  writeWikiPage(filePath, content, frontmatter);

  // Persist version history
  if (!existsSync(versionsDir)) {
    mkdirSync(versionsDir, { recursive: true });
  }
  writeFileSync(versionsFile, JSON.stringify(versions, null, 2), 'utf-8');
}

/** Read version history for a page */
export function readPageVersions(vaultRoot: string, slug: string): PageVersion[] {
  const versionsFile = join(vaultRoot, '.wikimem', 'versions', `${slug}.versions.json`);
  if (!existsSync(versionsFile)) return [];
  try {
    return JSON.parse(readFileSync(versionsFile, 'utf-8')) as PageVersion[];
  } catch {
    return [];
  }
}

export function listWikiPages(wikiDir: string): string[] {
  if (!existsSync(wikiDir)) return [];
  const pages: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        pages.push(full);
      }
    }
  }

  walk(wikiDir);
  return pages;
}

export function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const link = match[1];
    if (link) links.push(link);
  }
  return [...new Set(links)];
}

export function getVaultStats(config: VaultConfig): VaultStats {
  const pages = listWikiPages(config.wikiDir);
  let totalWords = 0;
  let totalLinks = 0;
  const allLinked = new Set<string>();
  const pageTitleMap = new Map<string, string>(); // path -> frontmatter title

  for (const pagePath of pages) {
    const page = readWikiPage(pagePath);
    totalWords += page.wordCount;
    totalLinks += page.wikilinks.length;
    pageTitleMap.set(pagePath, page.title);
    for (const link of page.wikilinks) {
      allLinked.add(link);
    }
  }

  // Check both frontmatter title AND filename — wikilinks may use either
  const orphans = pages.filter((p) => {
    const fileName = basename(p, '.md');
    const title = pageTitleMap.get(p) ?? fileName;
    return !allLinked.has(title) && !allLinked.has(fileName) && fileName !== 'index' && fileName !== 'log';
  });

  const rawFiles = existsSync(config.rawDir)
    ? readdirSync(config.rawDir, { recursive: true }).filter(
        (f) => typeof f === 'string' && !f.startsWith('.'),
      ).length
    : 0;

  return {
    pageCount: pages.length,
    wordCount: totalWords,
    sourceCount: rawFiles,
    wikilinks: totalLinks,
    orphanPages: orphans.length,
    lastUpdated: new Date().toISOString().split('T')[0] ?? '',
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function toWikilink(title: string): string {
  return `[[${title}]]`;
}
