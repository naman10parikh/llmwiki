import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { readWikiPage, writeWikiPage, listWikiPages, slugify } from './vault.js';
import { updateIndex } from './index-manager.js';
import { appendLog } from './log-manager.js';
import { processText } from '../processors/text.js';
import { processUrl } from '../processors/url.js';

export interface IngestResult {
  title: string;
  pagesUpdated: number;
  linksAdded: number;
  rawPath: string;
  rejected?: boolean;
  rejectionReason?: string;
}

interface IngestOptions {
  verbose: boolean;
  force?: boolean;
}

export async function ingestSource(
  source: string,
  config: VaultConfig,
  provider: LLMProvider,
  options: IngestOptions,
): Promise<IngestResult> {
  const isUrl = source.startsWith('http://') || source.startsWith('https://');
  const now = new Date().toISOString().split('T')[0] ?? '';

  // Step 1: Get content as markdown
  let content: string;
  let title: string;
  let rawPath: string;

  if (isUrl) {
    const urlResult = await processUrl(source);
    content = urlResult.content;
    title = urlResult.title;
    // Save to raw/ with date stamp
    const dateDir = join(config.rawDir, now);
    mkdirSync(dateDir, { recursive: true });
    rawPath = join(dateDir, `${slugify(title)}.md`);
    writeFileSync(rawPath, content, 'utf-8');
  } else {
    if (!existsSync(source)) {
      throw new Error(`File not found: ${source}`);
    }
    const ext = extname(source).toLowerCase();
    rawPath = source;

    // Copy to raw/ if not already there
    if (!source.startsWith(config.rawDir)) {
      const dateDir = join(config.rawDir, now);
      mkdirSync(dateDir, { recursive: true });
      rawPath = join(dateDir, basename(source));
      copyFileSync(source, rawPath);
    }

    // Process based on file type
    switch (ext) {
      case '.md':
      case '.txt':
      case '.csv':
        content = readFileSync(source, 'utf-8');
        title = basename(source, ext);
        break;
      default:
        content = readFileSync(source, 'utf-8');
        title = basename(source, ext);
    }
  }

  // Step 2: Semantic dedup check (unless --force)
  if (!options.force) {
    const existingPages = listWikiPages(config.wikiDir);
    const isDuplicate = await checkDuplicate(content, existingPages, provider);
    if (isDuplicate.duplicate) {
      // Mark in raw/ frontmatter but don't add to wiki
      const rejectionMeta = {
        title,
        rejected: true,
        rejection_reason: isDuplicate.reason,
        similar_to: isDuplicate.similarPage,
        similarity_score: isDuplicate.score,
        source: rawPath,
        date: now,
      };
      // Write rejection metadata alongside the raw file
      writeFileSync(
        rawPath + '.meta.json',
        JSON.stringify(rejectionMeta, null, 2),
        'utf-8',
      );
      return {
        title,
        pagesUpdated: 0,
        linksAdded: 0,
        rawPath,
        rejected: true,
        rejectionReason: isDuplicate.reason,
      };
    }
  }

  // Step 3: Ask LLM to process and integrate into wiki
  const schema = existsSync(config.schemaPath)
    ? readFileSync(config.schemaPath, 'utf-8')
    : '';

  const indexContent = existsSync(config.indexPath)
    ? readFileSync(config.indexPath, 'utf-8')
    : '';

  const prompt = buildIngestPrompt(content, title, schema, indexContent);

  const response = await provider.chat([
    { role: 'user', content: prompt },
  ], {
    systemPrompt: `You are a wiki maintainer. You process source documents and produce structured wiki pages in markdown with YAML frontmatter and [[wikilinks]]. Follow the schema in AGENTS.md exactly. Be concise, factual, and thorough in cross-referencing.`,
    maxTokens: 8192,
  });

  // Step 4: Parse LLM response into wiki pages
  const pages = parseLLMPages(response.content);
  let pagesUpdated = 0;
  let linksAdded = 0;

  for (const page of pages) {
    const pagePath = join(config.wikiDir, page.category, `${slugify(page.title)}.md`);
    const dir = join(pagePath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeWikiPage(pagePath, page.content, {
      title: page.title,
      type: page.category,
      created: now,
      updated: now,
      tags: page.tags,
      sources: [rawPath],
      summary: page.summary,
    });

    pagesUpdated++;
    linksAdded += (page.content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
  }

  // Step 5: Update index.md and log.md
  await updateIndex(config, pages);
  appendLog(config.logPath, `ingest | ${title}`, `Processed ${source}. Created/updated ${pagesUpdated} pages.`);

  return { title, pagesUpdated, linksAdded, rawPath };
}

interface DuplicateCheck {
  duplicate: boolean;
  reason: string;
  similarPage?: string;
  score?: number;
}

async function checkDuplicate(
  content: string,
  existingPages: string[],
  provider: LLMProvider,
): Promise<DuplicateCheck> {
  if (existingPages.length === 0) {
    return { duplicate: false, reason: '' };
  }

  // Simple heuristic first: check content length overlap
  const contentSnippet = content.substring(0, 500);

  for (const pagePath of existingPages.slice(0, 20)) {
    try {
      const page = readWikiPage(pagePath);
      const pageSnippet = page.content.substring(0, 500);

      // Simple Jaccard similarity on word sets
      const wordsA = new Set(contentSnippet.toLowerCase().split(/\s+/));
      const wordsB = new Set(pageSnippet.toLowerCase().split(/\s+/));
      const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
      const union = new Set([...wordsA, ...wordsB]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      if (similarity > 0.7) {
        return {
          duplicate: true,
          reason: `High word overlap (${Math.round(similarity * 100)}%) with existing page "${page.title}"`,
          similarPage: pagePath,
          score: similarity,
        };
      }
    } catch {
      // Skip unreadable pages
    }
  }

  return { duplicate: false, reason: '' };
}

function buildIngestPrompt(
  content: string,
  title: string,
  schema: string,
  indexContent: string,
): string {
  return `# Task: Ingest Source Document

## Schema (AGENTS.md)
${schema}

## Current Wiki Index
${indexContent}

## Source Document: "${title}"
${content.substring(0, 12000)}

## Instructions

Process this source document and produce wiki pages. For each page, output in this exact format:

\`\`\`page
TITLE: Page Title
CATEGORY: sources | entities | concepts | syntheses
TAGS: tag1, tag2, tag3
SUMMARY: One-line summary for the index
---
Page content in markdown with [[wikilinks]] to other pages.
\`\`\`

Produce:
1. A source summary page (in sources/)
2. Entity pages for any notable people, tools, organizations mentioned (in entities/)
3. Concept pages for key ideas or frameworks discussed (in concepts/)

Use [[wikilinks]] extensively to connect pages. Every claim should reference its source.`;
}

interface ParsedPage {
  title: string;
  category: string;
  tags: string[];
  summary: string;
  content: string;
}

function parseLLMPages(response: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const pageBlocks = response.split('```page').slice(1);

  for (const block of pageBlocks) {
    const endIdx = block.indexOf('```');
    const pageContent = endIdx >= 0 ? block.substring(0, endIdx) : block;

    const lines = pageContent.trim().split('\n');
    const titleLine = lines.find((l) => l.startsWith('TITLE:'));
    const categoryLine = lines.find((l) => l.startsWith('CATEGORY:'));
    const tagsLine = lines.find((l) => l.startsWith('TAGS:'));
    const summaryLine = lines.find((l) => l.startsWith('SUMMARY:'));

    const separatorIdx = lines.findIndex((l) => l.trim() === '---');
    const content = separatorIdx >= 0 ? lines.slice(separatorIdx + 1).join('\n').trim() : '';

    if (titleLine && categoryLine) {
      pages.push({
        title: titleLine.replace('TITLE:', '').trim(),
        category: categoryLine.replace('CATEGORY:', '').trim(),
        tags: (tagsLine?.replace('TAGS:', '').trim() ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        summary: summaryLine?.replace('SUMMARY:', '').trim() ?? '',
        content,
      });
    }
  }

  // If no structured pages found, create a single source page
  if (pages.length === 0 && response.trim().length > 0) {
    pages.push({
      title: 'Untitled Source',
      category: 'sources',
      tags: [],
      summary: 'Auto-generated source page',
      content: response,
    });
  }

  return pages;
}
