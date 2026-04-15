import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { LLMProvider, LLMResponse } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { readWikiPage, writeWikiPage, writeWikiPageVersioned, listWikiPages, slugify } from './vault.js';
import { updateIndex } from './index-manager.js';
import { appendLog } from './log-manager.js';
import { getPrompt } from './pipeline-prompts.js';
import { processText } from '../processors/text.js';
import { processUrl } from '../processors/url.js';
import { isImageFile, processImage } from '../processors/image.js';
import { isAudioFile, processAudio } from '../processors/audio.js';
import { isVideoFile, processVideo } from '../processors/video.js';
import { isPdfFile, processPdf } from '../processors/pdf.js';
import { processDocx } from '../processors/docx.js';
import { processXlsx } from '../processors/xlsx.js';
import { processPptx } from '../processors/pptx.js';
import { isCsvFile, processCsv } from '../processors/csv.js';
import { embedPage } from '../search/semantic.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';

export interface IngestResult {
  title: string;
  pagesUpdated: number;
  linksAdded: number;
  rawPath: string;
  rejected?: boolean;
  rejectionReason?: string;
}

export interface IngestOptions {
  verbose: boolean;
  force?: boolean;
  tags?: string[];
  category?: string;
  metadata?: Record<string, string>;
  embeddingProvider?: EmbeddingProvider;
  addedBy?: 'human' | 'agent' | 'webhook' | 'observer';
}

export async function ingestSource(
  source: string,
  config: VaultConfig,
  provider: LLMProvider,
  options: IngestOptions,
): Promise<IngestResult> {
  const { pipelineEvents } = await import('./pipeline-events.js');
  pipelineEvents.startRun(source);

  try {
    return await _ingestSourceInner(source, config, provider, options, pipelineEvents);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pipelineEvents.errorRun(msg);
    throw err;
  }
}

async function _ingestSourceInner(
  source: string,
  config: VaultConfig,
  provider: LLMProvider,
  options: IngestOptions,
  pipelineEvents: Awaited<typeof import('./pipeline-events.js')>['pipelineEvents'],
): Promise<IngestResult> {
  pipelineEvents.emitStep('detect', 'running', `Detecting type of ${basename(source)}`);

  const isUrl = source.startsWith('http://') || source.startsWith('https://');
  const now = new Date().toISOString().split('T')[0] ?? '';

  // Step 1: Get content as markdown
  let content: string;
  let title: string;
  let rawPath: string;

  let needsCopyToRaw = false;

  pipelineEvents.emitStep('detect', 'done', isUrl ? 'URL source' : `File: ${extname(source) || 'unknown'}`);
  pipelineEvents.emitStep('extract', 'running', 'Extracting content...');

  if (isUrl) {
    const urlResult = await processUrl(source);
    content = urlResult.content;
    title = urlResult.title;
    // Will save to raw/ after dedup check
    const dateDir = join(config.rawDir, now);
    mkdirSync(dateDir, { recursive: true });
    rawPath = join(dateDir, `${slugify(title)}.md`);
    needsCopyToRaw = true;
  } else {
    if (!existsSync(source)) {
      throw new Error(`File not found: ${source}`);
    }
    const ext = extname(source).toLowerCase();
    rawPath = source;

    // Determine raw path but don't copy yet (dedup check first)
    if (!source.startsWith(config.rawDir)) {
      const dateDir = join(config.rawDir, now);
      mkdirSync(dateDir, { recursive: true });
      rawPath = join(dateDir, basename(source));
      needsCopyToRaw = true;
    }

    // Process based on file type — supports every major format
    if (isImageFile(source)) {
      const result = await processImage(source);
      content = result.markdown;
      title = result.title;
    } else if (isAudioFile(source)) {
      const result = await processAudio(source);
      content = result.markdown;
      title = result.title;
    } else if (isVideoFile(source)) {
      const result = await processVideo(source);
      content = result.markdown;
      title = result.title;
    } else if (isPdfFile(source)) {
      const result = await processPdf(source);
      content = result.markdown;
      title = result.title;
    } else {
      // Text-based formats: .md, .txt, .csv, .json, .yaml, .xml, .html,
      // Office formats: .docx, .xlsx, .pptx (full extraction)
      switch (ext) {
        case '.docx':
        case '.doc': {
          const docResult = await processDocx(source);
          content = docResult.markdown;
          title = docResult.title;
          break;
        }
        case '.xlsx':
        case '.xls': {
          const xlsResult = await processXlsx(source);
          content = xlsResult.markdown;
          title = xlsResult.title;
          break;
        }
        case '.pptx':
        case '.ppt': {
          const pptResult = await processPptx(source);
          content = pptResult.markdown;
          title = pptResult.title;
          break;
        }
        case '.csv':
        case '.tsv': {
          const csvResult = await processCsv(source);
          content = csvResult.markdown;
          title = csvResult.title;
          break;
        }
        case '.json':
          content = `# ${basename(source, ext)}\n\n\`\`\`json\n${readFileSync(source, 'utf-8').substring(0, 20000)}\n\`\`\``;
          title = basename(source, ext);
          break;
        case '.html':
        case '.htm': {
          const html = readFileSync(source, 'utf-8');
          const htmlTitle = html.match(/<title>(.*?)<\/title>/i)?.[1];
          // Remove script/style blocks, decode entities, strip tags
          let cleaned = html;
          cleaned = cleaned.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
          cleaned = cleaned.replace(/<\/?(br|p|div|li|h[1-6]|tr|blockquote)[^>]*>/gi, '\n');
          cleaned = cleaned.replace(/<[^>]+>/g, '');
          cleaned = cleaned.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
          cleaned = cleaned.replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)));
          cleaned = cleaned.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
          cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          content = cleaned.substring(0, 20000);
          title = htmlTitle ?? basename(source, ext);
          break;
        }
        default:
          content = readFileSync(source, 'utf-8');
          title = basename(source, ext);
      }
    }
  }

  pipelineEvents.emitStep('extract', 'done', `Extracted: "${title}"`);
  pipelineEvents.emitStep('dedup', 'running', 'Checking for duplicates...');

  // Step 2: Semantic dedup check (unless --force)
  if (!options.force) {
    const existingPages = listWikiPages(config.wikiDir);
    // Only skip self-match when source is already in raw/ (not being copied)
    const skipSelf = needsCopyToRaw ? undefined : rawPath;
    const isDuplicate = await checkDuplicate(content, existingPages, provider, config.rawDir, skipSelf);
    if (isDuplicate.duplicate) {
      // Copy to raw/ so we can write meta alongside it
      if (needsCopyToRaw) {
        if (isUrl) {
          writeFileSync(rawPath, content, 'utf-8');
        } else {
          copyFileSync(source, rawPath);
        }
      }
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
      pipelineEvents.emitStep('dedup', 'done', `Duplicate: ${isDuplicate.reason}`);
      pipelineEvents.errorRun(`Rejected: ${isDuplicate.reason}`);
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

  pipelineEvents.emitStep('dedup', options.force ? 'skipped' : 'done', options.force ? 'Skipped (--force)' : 'No duplicates found');
  pipelineEvents.emitStep('copy-raw', 'running', 'Copying to raw/...');

  // Step 2.5: Copy source to raw/ now that dedup passed
  if (needsCopyToRaw) {
    if (isUrl) {
      writeFileSync(rawPath, content, 'utf-8');
    } else {
      copyFileSync(source, rawPath);
    }
  }

  pipelineEvents.emitStep('copy-raw', needsCopyToRaw ? 'done' : 'skipped', needsCopyToRaw ? `Saved to raw/${now}/` : 'Already in raw/');
  pipelineEvents.emitStep('llm-compile', 'running', 'Asking LLM to analyze and generate wiki pages...');

  // Step 3: Ask LLM to process and integrate into wiki
  const schema = existsSync(config.schemaPath)
    ? readFileSync(config.schemaPath, 'utf-8')
    : '';

  const indexContent = existsSync(config.indexPath)
    ? readFileSync(config.indexPath, 'utf-8')
    : '';

  // Load prompt overrides from config.yaml (UXO-077)
  const { loadConfig } = await import('./config.js');
  const userConfig = loadConfig(config.configPath);
  const promptOverrides = userConfig.pipeline?.prompts ?? {};

  const prompt = buildIngestPrompt(content, title, schema, indexContent, getPrompt('llm-compile-user', promptOverrides));

  // Detect source type and enhance system prompt accordingly
  const { detectSourceType, getSourceTypePrompt } = await import('../templates/source-types.js');
  const ext = extname(source).toLowerCase();
  const mimeGuess = ext === '.pdf' ? 'application/pdf' : ext === '.mp3' || ext === '.wav' ? 'audio/' : ext === '.mp4' ? 'video/' : ext === '.html' ? 'text/html' : undefined;
  const detectedType = detectSourceType(content, title, mimeGuess);
  const sourceTypeAddition = getSourceTypePrompt(detectedType);

  const systemPromptBase = getPrompt('llm-compile-system', promptOverrides);
  const systemPrompt = `${systemPromptBase}${sourceTypeAddition}`;

  const llmStart = Date.now();

  const response = await provider.chat([
    { role: 'user', content: prompt },
  ], {
    systemPrompt,
    maxTokens: 8192,
  });

  const llmDuration = Date.now() - llmStart;

  pipelineEvents.setLLMTrace({
    systemPrompt,
    userPrompt: prompt.substring(0, 2000) + (prompt.length > 2000 ? '\n...(truncated)' : ''),
    response: response.content.substring(0, 3000) + (response.content.length > 3000 ? '\n...(truncated)' : ''),
    durationMs: llmDuration,
  });

  pipelineEvents.emitStep('write-pages', 'running', 'Writing wiki pages...');

  // Step 4: Parse LLM response into wiki pages
  const pages = parseLLMPages(response.content);
  let pagesUpdated = 0;
  let linksAdded = 0;

  // Generate a session ID for multi-session reasoning (COMP-MP-005)
  const sessionId = `ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  for (const page of pages) {
    // User-supplied category overrides LLM-detected category
    const pageCategory = options.category ?? page.category;
    const pagePath = join(config.wikiDir, pageCategory, `${slugify(page.title)}.md`);
    const dir = join(pagePath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Merge user-supplied tags with LLM-detected tags (dedup)
    const mergedTags = [...new Set([...page.tags, ...(options.tags ?? [])])];

    // Compute initial confidence score (0-100)
    const confidence = computeConfidence(page, rawPath, response.model ?? 'unknown');

    const frontmatterData: Record<string, unknown> = {
      title: page.title,
      type: pageCategory,
      created: now,
      updated: now,
      tags: mergedTags,
      sources: [rawPath],
      summary: page.summary,
      ...(page.tldr ? { tldr: page.tldr } : {}),
      added_by: options.addedBy ?? 'human',
      confidence,
      validation_status: 'unreviewed',
    };

    // Merge any custom metadata from --interactive or future extensions
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        frontmatterData[key] = value;
      }
    }

    // Use versioned write: adds learned_at, fact_version, ingest_session,
    // and archives previous content if page already exists (COMP-MP-002)
    writeWikiPageVersioned(pagePath, page.content, frontmatterData, config.root, {
      source: rawPath,
      actor: options.addedBy ?? 'human',
      sessionId,
    });

    pagesUpdated++;
    linksAdded += (page.content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
  }

  pipelineEvents.emitStep('write-pages', 'done', `${pagesUpdated} pages written, ${linksAdded} links`);
  pipelineEvents.emitStep('embed', options.embeddingProvider ? 'running' : 'skipped', options.embeddingProvider ? 'Generating embeddings...' : 'No embedding provider');

  // Step 5: Generate embeddings for new pages (if provider configured)
  if (options.embeddingProvider) {
    for (const page of pages) {
      const pageCategory = options.category ?? page.category;
      const pagePath = join(config.wikiDir, pageCategory, `${slugify(page.title)}.md`);
      try {
        await embedPage(pagePath, page.content, options.embeddingProvider);
      } catch {
        // Embedding failure is non-fatal — page is still ingested
      }
    }
  }

  if (options.embeddingProvider) pipelineEvents.emitStep('embed', 'done', 'Embeddings generated');
  pipelineEvents.emitStep('update-index', 'running', 'Updating index and log...');

  // Step 6: Update index.md and log.md
  await updateIndex(config, pages);
  appendLog(config.logPath, `ingest | ${title}`, `Processed ${source}. Created/updated ${pagesUpdated} pages.`);

  pipelineEvents.emitStep('update-index', 'done', 'Index and log updated');
  pipelineEvents.emitStep('git-commit', 'running', 'Auto-committing to git...');

  // Step 7: Auto-commit to git if vault is a git repo
  try {
    const { autoCommit } = await import('./git.js');
    const result = await autoCommit(
      config.root,
      'ingest',
      `add ${pagesUpdated} pages from ${basename(source)}`,
      `Source: ${source}\nPages: ${pagesUpdated}\nLinks: ${linksAdded}`,
    );
    pipelineEvents.emitStep('git-commit', result ? 'done' : 'skipped', result ? `Committed: ${result.hash.substring(0, 7)}` : 'Not a git repo');
  } catch {
    pipelineEvents.emitStep('git-commit', 'skipped', 'Git not available');
  }

  const pagesCreatedList = pages.filter(p => p.category === 'sources' || p.category === 'concepts' || p.category === 'syntheses').map(p => p.title);
  const entitiesFound = pages.filter(p => p.category === 'entities').map(p => p.title);
  const conceptsFound = pages.filter(p => p.category === 'concepts').map(p => p.title);

  pipelineEvents.setSummary({
    whatHappened: `Ingested "${title}" and generated ${pagesUpdated} wiki pages with ${linksAdded} cross-references.`,
    pagesCreated: pagesCreatedList,
    pagesUpdated: [],
    entitiesFound,
    conceptsFound,
    linksCreated: linksAdded,
    decisionsExplained: `The AI analyzed the source document, identified ${entitiesFound.length} entities and ${conceptsFound.length} concepts, then created structured wiki pages with cross-references to existing knowledge.`,
  });

  // Step 8: Record history snapshot for time-lapse
  try {
    const { recordSnapshot } = await import('./history.js');
    recordSnapshot(config, 'ingest', `Ingested "${title}": ${pagesUpdated} pages, ${linksAdded} links`);
  } catch {
    // History recording is optional
  }

  pipelineEvents.completeRun({ pagesCreated: pagesUpdated, linksAdded, title });

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
  _provider: LLMProvider,
  rawDir?: string,
  currentRawPath?: string,
): Promise<DuplicateCheck> {
  // Check 1: Exact content hash match against existing raw sources
  if (rawDir && existsSync(rawDir)) {
    const newHash = createHash('sha256').update(content).digest('hex');
    const existingHash = findExistingRawHash(rawDir, newHash, content, currentRawPath);
    if (existingHash) {
      return {
        duplicate: true,
        reason: `Exact duplicate of previously ingested source "${existingHash}"`,
        similarPage: existingHash,
        score: 1.0,
      };
    }
  }

  if (existingPages.length === 0) {
    return { duplicate: false, reason: '' };
  }

  // Check 2: Jaccard similarity against wiki pages
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

/** Walk raw/ and compare content to detect exact duplicate sources */
function findExistingRawHash(
  rawDir: string,
  _newHash: string,
  newContent: string,
  skipPath?: string,
): string | undefined {
  const newNorm = newContent.trim();
  const skipResolved = skipPath ? resolve(skipPath) : undefined;
  try {
    const entries = readdirSync(rawDir);
    for (const entry of entries) {
      const full = join(rawDir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        const result = findExistingRawHash(full, _newHash, newContent, skipPath);
        if (result) return result;
      } else if (!entry.endsWith('.meta.json') && !entry.startsWith('.')) {
        // Skip the file we're currently ingesting
        if (skipResolved && resolve(full) === skipResolved) continue;
        try {
          const existing = readFileSync(full, 'utf-8').trim();
          if (existing === newNorm) return basename(full);
        } catch {
          // Binary file or read error — skip
        }
      }
    }
  } catch {
    // Dir read error
  }
  return undefined;
}

/**
 * Compute an initial confidence score (0-100) for an auto-generated page.
 * Factors: source file type, content length, wikilink density, model tier, summary presence.
 */
function computeConfidence(
  page: ParsedPage,
  rawPath: string,
  model: string,
): number {
  let score = 50; // baseline

  // Source quality: structured formats score higher
  const ext = rawPath.split('.').pop()?.toLowerCase() ?? '';
  const structuredExts = ['json', 'yaml', 'yml', 'csv', 'xlsx', 'tsv'];
  const richExts = ['md', 'html', 'htm', 'tex'];
  if (structuredExts.includes(ext)) score += 10;
  else if (richExts.includes(ext)) score += 8;
  else if (ext === 'pdf') score += 5;
  else if (['txt', 'log'].includes(ext)) score += 2;

  // Content density: longer, more detailed content = higher confidence
  const wordCount = (page.content || '').split(/\s+/).filter(Boolean).length;
  if (wordCount > 300) score += 10;
  else if (wordCount > 100) score += 5;
  else if (wordCount < 30) score -= 10;

  // Wikilink density: more cross-references = better integration
  const linkCount = (page.content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
  if (linkCount >= 5) score += 8;
  else if (linkCount >= 2) score += 4;
  else if (linkCount === 0) score -= 5;

  // Summary present
  if (page.summary && page.summary.trim().length > 20) score += 5;

  // Model tier bonus
  const modelLower = model.toLowerCase();
  if (modelLower.includes('opus') || modelLower.includes('gpt-4') || modelLower.includes('sonnet')) score += 7;
  else if (modelLower.includes('haiku') || modelLower.includes('gpt-3') || modelLower.includes('mini')) score -= 3;

  return Math.max(0, Math.min(100, score));
}

function buildIngestPrompt(
  content: string,
  title: string,
  schema: string,
  indexContent: string,
  userInstructions: string,
): string {
  return `# Task: Ingest Source Document

## Schema (AGENTS.md)
${schema}

## Current Wiki Index
${indexContent}

## Source Document: "${title}"
${content.substring(0, 12000)}

## Instructions

${userInstructions}`;
}

interface ParsedPage {
  title: string;
  category: string;
  tags: string[];
  summary: string;
  tldr: string;
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
    const tldrLine = lines.find((l) => l.startsWith('TLDR:'));

    const separatorIdx = lines.findIndex((l) => l.trim() === '---');
    const content = separatorIdx >= 0 ? lines.slice(separatorIdx + 1).join('\n').trim() : '';

    if (titleLine && categoryLine) {
      pages.push({
        title: titleLine.replace('TITLE:', '').trim(),
        category: categoryLine.replace('CATEGORY:', '').trim(),
        tags: (tagsLine?.replace('TAGS:', '').trim() ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        summary: summaryLine?.replace('SUMMARY:', '').trim() ?? '',
        tldr: tldrLine?.replace('TLDR:', '').trim() ?? '',
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
      tldr: '',
      content: response,
    });
  }

  return pages;
}

// --- Batch Ingest ---

export interface BatchIngestResult {
  ingested: number;
  skipped: number;
  duplicates: number;
  errors: number;
  results: Array<{ file: string; result?: IngestResult; error?: string }>;
}

/** Collect ingestable files from a directory */
export function collectFiles(dir: string, recursive: boolean): string[] {
  const files: string[] = [];
  const resolved = resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return files;
  }

  const entries = readdirSync(resolved);
  for (const entry of entries) {
    // Skip hidden files and .meta.json files
    if (entry.startsWith('.') || entry.endsWith('.meta.json')) continue;
    const full = join(resolved, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && recursive) {
      files.push(...collectFiles(full, true));
    } else if (stat.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** Check if a file was already ingested by reading log.md */
export function isAlreadyIngested(logPath: string, filePath: string): boolean {
  if (!existsSync(logPath)) return false;
  const log = readFileSync(logPath, 'utf-8');
  const fileName = basename(filePath);
  return log.includes(fileName);
}

// --- Duplicate Listing ---

export interface DuplicateEntry {
  file: string;
  title: string;
  reason: string;
  similarTo: string;
  score: number;
  date: string;
}

/** Scan raw/ for .meta.json files indicating rejected duplicates */
export function listDuplicates(rawDir: string): DuplicateEntry[] {
  const duplicates: DuplicateEntry[] = [];
  if (!existsSync(rawDir)) return duplicates;

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.meta.json')) {
        try {
          const raw = readFileSync(full, 'utf-8');
          const meta = JSON.parse(raw) as Record<string, unknown>;
          if (meta['rejected'] === true) {
            duplicates.push({
              file: full.replace('.meta.json', ''),
              title: (meta['title'] as string) ?? basename(full, '.meta.json'),
              reason: (meta['rejection_reason'] as string) ?? 'Unknown',
              similarTo: (meta['similar_to'] as string) ?? 'Unknown',
              score: (meta['similarity_score'] as number) ?? 0,
              date: (meta['date'] as string) ?? '',
            });
          }
        } catch {
          // Skip malformed meta files
        }
      }
    }
  }

  walk(rawDir);
  return duplicates;
}
