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
  const allPages = new Set<string>();

  for (const pagePath of pages) {
    const page = readWikiPage(pagePath);
    totalWords += page.wordCount;
    totalLinks += page.wikilinks.length;
    allPages.add(page.title);
    for (const link of page.wikilinks) {
      allLinked.add(link);
    }
  }

  const orphans = pages.filter((p) => {
    const title = basename(p, '.md');
    return !allLinked.has(title) && title !== 'index' && title !== 'log';
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
