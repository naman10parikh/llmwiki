import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface PdfResult {
  title: string;
  content: string;
  markdown: string;
  pageCount?: number;
  sourcePath: string;
}

export function isPdfFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf');
}

export async function processPdf(filePath: string): Promise<PdfResult> {
  const title = basename(filePath, '.pdf');
  const buffer = readFileSync(filePath);

  try {
    // pdf-parse v1: simple function call
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>;
    const data = await pdfParse(buffer);
    const content = data.text.trim();

    return {
      title,
      content,
      markdown: buildMarkdown(title, filePath, content, data.numpages),
      pageCount: data.numpages,
      sourcePath: filePath,
    };
  } catch {
    return {
      title,
      content: `[PDF: ${title} — text extraction failed]`,
      markdown: buildMarkdown(title, filePath, '[Text extraction failed — PDF may be scanned/image-only]'),
      sourcePath: filePath,
    };
  }
}

function buildMarkdown(title: string, filePath: string, content: string, pageCount?: number): string {
  return `# ${title}

> **Source:** [${basename(filePath)}](${filePath})
> **Type:** PDF${pageCount ? `\n> **Pages:** ${pageCount}` : ''}
> **Processed:** ${new Date().toISOString().split('T')[0]}

## Content

${content}
`;
}
