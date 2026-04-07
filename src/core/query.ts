import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage, writeWikiPage, slugify } from './vault.js';
import { searchPages } from '../search/index.js';
import { appendLog } from './log-manager.js';

export interface QueryResult {
  answer: string;
  sourcesConsulted: string[];
  filedAs?: string;
}

interface QueryOptions {
  fileBack: boolean;
}

export async function queryWiki(
  question: string,
  config: VaultConfig,
  provider: LLMProvider,
  options: QueryOptions,
): Promise<QueryResult> {
  // Step 1: Search index for relevant pages
  const indexContent = existsSync(config.indexPath)
    ? readFileSync(config.indexPath, 'utf-8')
    : '';

  const allPages = listWikiPages(config.wikiDir);
  const relevantPages = searchPages(question, allPages);

  // Step 2: Read the most relevant pages (up to 10)
  const pageContents: string[] = [];
  const sourcesConsulted: string[] = [];

  for (const pagePath of relevantPages.slice(0, 10)) {
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

  const response = await provider.chat([
    { role: 'user', content: prompt },
  ], {
    systemPrompt: 'You are a knowledgeable wiki assistant. Answer questions by synthesizing information from the wiki pages provided. Always cite sources using [[wikilinks]]. Be concise and accurate.',
    maxTokens: 4096,
  });

  // Step 4: Optionally file the answer back into the wiki
  let filedAs: string | undefined;
  if (options.fileBack) {
    const now = new Date().toISOString().split('T')[0] ?? '';
    const slug = slugify(question.substring(0, 50));
    const filePath = join(config.wikiDir, 'syntheses', `${slug}.md`);

    writeWikiPage(filePath, response.content, {
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
    answer: response.content,
    sourcesConsulted,
    filedAs,
  };
}
