/**
 * Notion Sync — fetches pages and databases via Notion's internal integration API,
 * converts blocks to markdown, and writes files into the wiki vault.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncFilters, SyncPreviewResult, PreviewItem } from './sync-filters.js';
import { estimateTokens, formatCostEstimate, isAfterSince } from './sync-filters.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionSyncOptions {
  token: string;
  vaultRoot: string;
  maxPages?: number;
  databaseIds?: string[];
  /** Sync filter overrides */
  filters?: SyncFilters;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface RichTextItem { plain_text: string }

interface NotionBlock { id: string; type: string; has_children: boolean; [k: string]: unknown }

interface NotionPage { id: string; last_edited_time: string; properties: Record<string, NotionProperty> }

interface NotionProperty {
  type: string; title?: RichTextItem[]; rich_text?: RichTextItem[];
  number?: number; select?: { name: string }; multi_select?: Array<{ name: string }>;
  date?: { start: string; end?: string }; checkbox?: boolean; url?: string;
  [k: string]: unknown;
}

interface Paginated<T> { results: T[]; has_more: boolean; next_cursor: string | null }

async function notionFetch<T>(url: string, token: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function richText(items: RichTextItem[] | undefined): string {
  return items?.map((t) => t.plain_text).join('') ?? '';
}

function blockToMd(block: NotionBlock): string {
  const data = block[block.type] as { rich_text?: RichTextItem[]; language?: string; checked?: boolean } | undefined;
  const text = richText(data?.rich_text);
  switch (block.type) {
    case 'paragraph': return text;
    case 'heading_1': return `# ${text}`;
    case 'heading_2': return `## ${text}`;
    case 'heading_3': return `### ${text}`;
    case 'bulleted_list_item': return `- ${text}`;
    case 'numbered_list_item': return `1. ${text}`;
    case 'to_do': return `- [${data?.checked ? 'x' : ' '}] ${text}`;
    case 'code': return `\`\`\`${data?.language ?? ''}\n${text}\n\`\`\``;
    case 'quote': case 'callout': return `> ${text}`;
    case 'divider': return '---';
    case 'toggle': return `<details><summary>${text}</summary></details>`;
    default: return text;
  }
}

function pageTitle(page: NotionPage): string {
  for (const p of Object.values(page.properties)) {
    if (p.type === 'title' && p.title?.length) return richText(p.title);
  }
  return `Untitled-${page.id.slice(0, 8)}`;
}

function propStr(prop: NotionProperty): string {
  switch (prop.type) {
    case 'title': return richText(prop.title);
    case 'rich_text': return richText(prop.rich_text);
    case 'number': return prop.number != null ? String(prop.number) : '';
    case 'select': return prop.select?.name ?? '';
    case 'multi_select': return (prop.multi_select ?? []).map((s) => s.name).join(', ');
    case 'date': return prop.date?.start ?? '';
    case 'checkbox': return prop.checkbox ? 'Yes' : 'No';
    case 'url': return prop.url ?? '';
    default: return '';
  }
}

function slugify(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function frontmatter(notionId: string, edited: string, title: string): string {
  return `---\ntitle: "${title.replace(/"/g, '\\"')}"\naddedBy: connector\nsource: notion\nnotionId: "${notionId}"\nlastEditedTime: "${edited}"\nsyncedAt: "${new Date().toISOString()}"\n---\n`;
}

async function fetchBlocks(pageId: string, token: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | null = null;
  do {
    const ep: string = `${NOTION_API}/blocks/${pageId}/children` + (cursor ? `?start_cursor=${cursor}` : '');
    const res: Paginated<NotionBlock> = await notionFetch<Paginated<NotionBlock>>(ep, token);
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function fetchPages(token: string, max: number): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  do {
    const body: Record<string, unknown> = {
      filter: { property: 'object', value: 'page' },
      page_size: Math.min(max - pages.length, 100),
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch<Paginated<NotionPage>>(`${NOTION_API}/search`, token, 'POST', body);
    pages.push(...res.results);
    cursor = res.has_more && pages.length < max ? res.next_cursor : null;
  } while (cursor);
  return pages.slice(0, max);
}

async function syncPage(page: NotionPage, outDir: string, token: string): Promise<string> {
  const title = pageTitle(page);
  const blocks = await fetchBlocks(page.id, token);
  const md = blocks.map(blockToMd).filter(Boolean).join('\n\n');
  const content = frontmatter(page.id, page.last_edited_time, title) + `# ${title}\n\n${md}\n`;
  const fp = join(outDir, `${slugify(title)}.md`);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

async function syncDatabase(dbId: string, outDir: string, token: string): Promise<string | null> {
  const entries: NotionPage[] = [];
  let cursor: string | null = null;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch<Paginated<NotionPage>>(`${NOTION_API}/databases/${dbId}/query`, token, 'POST', body);
    entries.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  const first = entries[0];
  if (!first) return null;
  const cols = Object.keys(first.properties);
  const header = `| ${cols.join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const rows = entries.map((e) => `| ${cols.map((c) => { const p = e.properties[c]; return p ? propStr(p) : ''; }).join(' | ')} |`);
  const content = frontmatter(dbId, new Date().toISOString(), `Database ${dbId.slice(0, 8)}`)
    + `# Database ${dbId.slice(0, 8)}\n\n${[header, sep, ...rows].join('\n')}\n`;
  const fp = join(outDir, `db-${dbId.slice(0, 8)}.md`);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Preview what Notion pages would be synced with the given filters */
export async function previewNotion(options: NotionSyncOptions): Promise<SyncPreviewResult> {
  const errors: string[] = [];
  const filters = options.filters ?? {};
  const max = filters.maxItems ?? options.maxPages ?? 50;

  try {
    let pages = await fetchPages(options.token, max);
    if (filters.since) {
      pages = pages.filter((p) => isAfterSince(p.last_edited_time, filters.since));
    }

    const items: PreviewItem[] = pages.map((page) => ({
      id: page.id,
      title: pageTitle(page),
      date: page.last_edited_time,
      type: 'page',
      sizeEstimate: 2000,
    }));

    const totalChars = items.reduce((sum, i) => sum + i.sizeEstimate, 0);
    const tokens = estimateTokens(totalChars, items.length);

    return {
      provider: 'notion',
      totalItems: items.length,
      items,
      estimatedTokens: tokens,
      costEstimate: formatCostEstimate(tokens),
      errors,
    };
  } catch (err) {
    errors.push(`Preview failed: ${errMsg(err)}`);
    return { provider: 'notion', totalItems: 0, items: [], estimatedTokens: 0, costEstimate: '0 tokens', errors };
  }
}

export async function syncNotion(options: NotionSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;
  const filters = options.filters ?? {};

  // Preview mode
  if (filters.preview) {
    const preview = await previewNotion(options);
    return { provider: 'notion', filesWritten: 0, errors: preview.errors, duration: Date.now() - start };
  }

  const max = filters.maxItems ?? options.maxPages ?? 50;
  const dbIds = filters.databaseIds ?? options.databaseIds;
  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(options.vaultRoot, 'raw', date);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  try {
    let pages = await fetchPages(options.token, max);
    if (filters.since) {
      pages = pages.filter((p) => isAfterSince(p.last_edited_time, filters.since));
    }
    for (const page of pages) {
      try { await syncPage(page, outDir, options.token); filesWritten++; }
      catch (err) { errors.push(`Page ${page.id}: ${errMsg(err)}`); }
    }
  } catch (err) { errors.push(`Search pages: ${errMsg(err)}`); }

  if (dbIds?.length) {
    for (const dbId of dbIds) {
      try { const r = await syncDatabase(dbId, outDir, options.token); if (r) filesWritten++; }
      catch (err) { errors.push(`Database ${dbId}: ${errMsg(err)}`); }
    }
  }

  return { provider: 'notion', filesWritten, errors, duration: Date.now() - start };
}
