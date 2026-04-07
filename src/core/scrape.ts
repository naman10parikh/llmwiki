import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultConfig } from './vault.js';
import type { UserConfig, SourceConfig } from './config.js';
import { slugify } from './vault.js';

export interface ScrapeResult {
  sourcesProcessed: number;
  filesDeposited: number;
  entries: Array<{
    source: string;
    files: number;
    date: string;
  }>;
}

export async function scrapeExternalSources(
  config: VaultConfig,
  userConfig: UserConfig,
  specificSource?: string,
): Promise<ScrapeResult> {
  const sources = userConfig.sources ?? [];
  const toProcess = specificSource
    ? sources.filter((s) => s.name === specificSource)
    : sources;

  const now = new Date().toISOString().split('T')[0] ?? '';
  const entries: ScrapeResult['entries'] = [];
  let totalFiles = 0;

  for (const source of toProcess) {
    const files = await scrapeSource(source, config, now);
    entries.push({ source: source.name, files, date: now });
    totalFiles += files;
  }

  return {
    sourcesProcessed: toProcess.length,
    filesDeposited: totalFiles,
    entries,
  };
}

async function scrapeSource(
  source: SourceConfig,
  config: VaultConfig,
  date: string,
): Promise<number> {
  const dateDir = join(config.rawDir, date);
  mkdirSync(dateDir, { recursive: true });

  switch (source.type) {
    case 'rss':
      return await scrapeRss(source, dateDir);
    case 'github':
      return await scrapeGitHub(source, dateDir);
    case 'url':
      return await scrapeUrl(source, dateDir);
    default:
      return 0;
  }
}

async function scrapeRss(source: SourceConfig, destDir: string): Promise<number> {
  if (!source.url) return 0;

  try {
    const response = await fetch(source.url);
    const text = await response.text();

    // Simple RSS parsing — extract <item> titles and links
    const items = text.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    let count = 0;

    for (const item of items.slice(0, 10)) {
      const title = item.match(/<title>(.*?)<\/title>/)?.[1] ?? 'Untitled';
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] ?? '';
      const description = item.match(/<description>(.*?)<\/description>/)?.[1] ?? '';

      const content = `# ${title}\n\nSource: ${link}\n\n${stripHtml(description)}`;
      const fileName = `${slugify(title.substring(0, 60))}.md`;
      writeFileSync(join(destDir, fileName), content, 'utf-8');
      count++;
    }

    return count;
  } catch {
    return 0;
  }
}

async function scrapeGitHub(source: SourceConfig, destDir: string): Promise<number> {
  if (!source.query) return 0;

  try {
    const response = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(source.query)}&sort=stars&per_page=10`,
      { headers: { 'Accept': 'application/vnd.github.v3+json' } },
    );

    if (!response.ok) return 0;

    const data = (await response.json()) as { items: Array<{ full_name: string; description: string; html_url: string; stargazers_count: number }> };
    let count = 0;

    for (const repo of data.items) {
      const content = `# ${repo.full_name}\n\n${repo.description ?? ''}\n\nURL: ${repo.html_url}\nStars: ${repo.stargazers_count}`;
      const fileName = `${slugify(repo.full_name)}.md`;
      writeFileSync(join(destDir, fileName), content, 'utf-8');
      count++;
    }

    return count;
  } catch {
    return 0;
  }
}

async function scrapeUrl(source: SourceConfig, destDir: string): Promise<number> {
  if (!source.url) return 0;

  try {
    const response = await fetch(source.url);
    const text = await response.text();
    const fileName = `${slugify(source.name)}.md`;
    writeFileSync(join(destDir, fileName), `# ${source.name}\n\nSource: ${source.url}\n\n${stripHtml(text).substring(0, 10000)}`, 'utf-8');
    return 1;
  } catch {
    return 0;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}
