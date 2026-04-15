import { readFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage, writeWikiPage, slugify } from './vault.js';
import { searchPages } from '../search/index.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import { appendLog } from './log-manager.js';

export interface QueryResult {
  answer: string;
  sourcesConsulted: string[];
  filedAs?: string;
}

interface QueryOptions {
  fileBack: boolean;
  searchMode?: 'bm25' | 'semantic' | 'hybrid';
  embeddingProvider?: EmbeddingProvider;
}

/**
 * KARP-006: Two-pass query.
 * Pass 1 — scan index.md TLDRs and summaries to identify the most relevant page titles.
 * Pass 2 — load full bodies only for the identified pages.
 * Saves 60-80% tokens on large wikis vs loading all pages upfront.
 */
async function twoPassPageSelection(
  question: string,
  allPages: string[],
  config: VaultConfig,
  provider: LLMProvider,
  searchMode: 'bm25' | 'semantic' | 'hybrid',
  embeddingProvider?: EmbeddingProvider,
): Promise<string[]> {
  // Pass 1a: BM25 keyword pre-filter (fast, no LLM cost)
  const candidatePages = await searchPages(question, allPages, {
    mode: searchMode,
    embeddingProvider,
    wikiDir: config.wikiDir,
  });

  // Pass 1b: Build a TLDR index from frontmatter (1-2 sentences per page, minimal tokens)
  // For small wikis (<= 20 pages) skip the second LLM pass — BM25 is enough
  if (candidatePages.length <= 10) {
    return candidatePages.slice(0, 10);
  }

  const tldrIndex: string[] = [];
  const slugToPath = new Map<string, string>();

  for (const pagePath of candidatePages.slice(0, 30)) {
    try {
      const page = readWikiPage(pagePath);
      const slug = basename(pagePath, extname(pagePath));
      slugToPath.set(page.title, pagePath);
      slugToPath.set(slug, pagePath);
      const tldr = (page.frontmatter['tldr'] as string | undefined) ??
                   (page.frontmatter['summary'] as string | undefined) ?? '';
      if (tldr) {
        tldrIndex.push(`- [[${page.title}]]: ${tldr}`);
      } else {
        // Fallback: use first 120 chars of content as snippet
        const snippet = page.content.replace(/^#+\s+.*/m, '').trim().substring(0, 120);
        tldrIndex.push(`- [[${page.title}]]: ${snippet}`);
      }
    } catch {
      // Skip unreadable pages
    }
  }

  // Pass 2: Ask LLM which pages are relevant, using only TLDRs (cheap)
  const selectionPrompt = `Given this question: "${question}"

Which of these wiki pages are most relevant? List up to 8 page titles, one per line, most relevant first.

Pages available:
${tldrIndex.join('\n')}

Reply with only the page titles, one per line. No explanation.`;

  const selectionResponse = await provider.chat([
    { role: 'user', content: selectionPrompt },
  ], {
    systemPrompt: 'You are a relevance filter. Select only the most relevant page titles from the list provided.',
    maxTokens: 512,
  });

  // Parse response back to file paths
  const selectedPaths: string[] = [];
  const lines = selectionResponse.content.split('\n').map(l => l.replace(/^-\s*\[\[|\]\]$/g, '').replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean);
  for (const line of lines) {
    const path = slugToPath.get(line);
    if (path && !selectedPaths.includes(path)) {
      selectedPaths.push(path);
    }
  }

  // Fall back to BM25 top results if LLM didn't return useful titles
  if (selectedPaths.length === 0) {
    return candidatePages.slice(0, 10);
  }

  return selectedPaths.slice(0, 8);
}

export async function queryWiki(
  question: string,
  config: VaultConfig,
  provider: LLMProvider,
  options: QueryOptions,
): Promise<QueryResult> {
  // Step 1 (KARP-006): Two-pass page selection — TLDR scan then full load
  const indexContent = existsSync(config.indexPath)
    ? readFileSync(config.indexPath, 'utf-8')
    : '';

  const allPages = listWikiPages(config.wikiDir);
  const relevantPages = await twoPassPageSelection(
    question,
    allPages,
    config,
    provider,
    options.searchMode ?? 'bm25',
    options.embeddingProvider,
  );

  // Step 2: Read full bodies for the selected pages only
  const pageContents: string[] = [];
  const sourcesConsulted: string[] = [];

  for (const pagePath of relevantPages) {
    try {
      const page = readWikiPage(pagePath);
      pageContents.push(`## ${page.title}\n${page.content}`);
      sourcesConsulted.push(page.title);
    } catch {
      // Skip unreadable pages
    }
  }

  // Step 3: Synthesize answer
  const schema = existsSync(config.schemaPath)
    ? readFileSync(config.schemaPath, 'utf-8')
    : '';

  const prompt = `# Query Against Wiki

## Question
${question}

## Wiki Index
${indexContent.substring(0, 3000)}

## Relevant Pages
${pageContents.join('\n\n---\n\n').substring(0, 20000)}

## Instructions
Answer the question based on the wiki content above. Use [[wikilinks]] when referencing pages. Cite your sources. If the wiki doesn't contain enough information, say so clearly.`;

  const systemPrompt = 'You are a knowledgeable wiki assistant. Answer questions by synthesizing information from the wiki pages provided. Always cite sources using [[wikilinks]]. Be concise and accurate.';

  const response = await provider.chat([
    { role: 'user', content: prompt },
  ], { systemPrompt, maxTokens: 4096 });
  const responseContent = response.content;

  // Step 4: Optionally file the answer back into the wiki
  let filedAs: string | undefined;
  if (options.fileBack) {
    const now = new Date().toISOString().split('T')[0] ?? '';
    const slug = slugify(question.substring(0, 50));
    const filePath = join(config.wikiDir, 'syntheses', `${slug}.md`);

    writeWikiPage(filePath, responseContent, {
      title: question,
      type: 'synthesis',
      created: now,
      tags: ['query-result'],
      summary: `Answer to: ${question}`,
      sources: sourcesConsulted.map((s) => `[[${s}]]`),
    });

    filedAs = filePath;
  }

  // Log the query
  appendLog(config.logPath, `query | ${question.substring(0, 60)}`, `Consulted ${sourcesConsulted.length} pages: ${sourcesConsulted.join(', ')}`);

  return {
    answer: responseContent,
    sourcesConsulted,
    filedAs,
  };
}
