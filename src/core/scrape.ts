import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultConfig } from './vault.js';
import type { UserConfig, SourceConfig } from './config.js';
import { slugify } from './vault.js';
import { appendLog } from './log-manager.js';

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

  // Log scrape results
  const sourceList = entries.map((e) => `${e.source}: ${e.files} file(s)`).join(', ');
  appendLog(
    config.logPath,
    `scrape | ${totalFiles} files from ${toProcess.length} source(s)`,
    sourceList || 'No files scraped.',
  );

  // Record history snapshot for time-lapse
  if (totalFiles > 0) {
    try {
      const { recordSnapshot } = await import('./history.js');
      recordSnapshot(config, 'scrape', `Scraped ${totalFiles} files from ${toProcess.length} source(s)`);
    } catch {
      // History recording is optional
    }
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
    const response = await fetch(source.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${source.url}`);
    }
    const text = await response.text();

    // Parse RSS/Atom items — supports <item> (RSS 2.0) and <entry> (Atom)
    const items = text.match(/<item>[\s\S]*?<\/item>/g)
      ?? text.match(/<entry>[\s\S]*?<\/entry>/g)
      ?? [];
    let count = 0;

    for (const item of items.slice(0, 10)) {
      const rawTitle = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'Untitled';
      const title = stripCdata(rawTitle).trim();
      // RSS uses <link>url</link>, Atom uses <link href="url"/>
      const link = item.match(/<link>\s*([\s\S]*?)\s*<\/link>/)?.[1]
        ?? item.match(/<link[^>]+href="([^"]+)"/)?.[1]
        ?? '';
      // Prefer <content:encoded> (full article) over <description> (summary)
      const rawBody = item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)?.[1]
        ?? item.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1]
        ?? item.match(/<description>([\s\S]*?)<\/description>/)?.[1]
        ?? '';
      const body = stripHtml(stripCdata(rawBody));
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]
        ?? item.match(/<published>([\s\S]*?)<\/published>/)?.[1]
        ?? '';

      const header = [`# ${title}`, '', `Source: ${link}`];
      if (pubDate) header.push(`Date: ${pubDate.trim()}`);
      header.push('');

      const content = header.join('\n') + body;
      const fileName = `${slugify(title.substring(0, 60))}.md`;
      writeFileSync(join(destDir, fileName), content, 'utf-8');
      count++;
    }

    return count;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('ENOTFOUND') || msg.includes('fetch failed') || msg.includes('abort')) {
      console.error(`  Network error scraping ${source.name}: check URL and internet connection`);
    }
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

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&ldquo;': '\u201C', '&rdquo;': '\u201D', '&lsquo;': '\u2018', '&rsquo;': '\u2019',
  '&hellip;': '…', '&bull;': '•', '&copy;': '©', '&reg;': '®', '&trade;': '™',
};

function stripHtml(html: string): string {
  let text = html;
  // Remove script, style, and noscript blocks entirely
  text = text.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Convert <br>, <p>, <div>, <li>, headings to newlines
  text = text.replace(/<\/?(br|p|div|li|h[1-6]|tr|blockquote)[^>]*>/gi, '\n');
  // Remove remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');
  // Decode numeric entities (&#123; and &#x7B;)
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  // Decode named entities
  text = text.replace(/&[a-z]+;/gi, (ent) => HTML_ENTITIES[ent.toLowerCase()] ?? ent);
  // Normalize whitespace: collapse runs of spaces, trim blank lines
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
