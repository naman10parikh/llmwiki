import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface PdfResult {
  title: string;
  content: string;
  pageCount?: number;
}

export async function processPdf(filePath: string): Promise<PdfResult> {
  // Simple PDF text extraction — reads raw bytes and extracts text streams
  // For production, consider using pdf-parse or pdfjs-dist
  const buffer = readFileSync(filePath);
  const text = extractTextFromPdf(buffer);
  const title = basename(filePath, extname(filePath));

  return {
    title,
    content: text || `[PDF content from ${title} — install pdf-parse for full extraction]`,
    pageCount: undefined,
  };
}

function extractTextFromPdf(buffer: Buffer): string {
  // Basic PDF text extraction by finding text streams
  const content = buffer.toString('latin1');
  const textParts: string[] = [];

  // Extract text between BT and ET markers (basic PDF text objects)
  const regex = /BT\s([\s\S]*?)\sET/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const block = match[1] ?? '';
    // Extract text from Tj and TJ operators
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch: RegExpExecArray | null;
    while ((tjMatch = tjRegex.exec(block)) !== null) {
      if (tjMatch[1]) textParts.push(tjMatch[1]);
    }
  }

  return textParts.join(' ').replace(/\s+/g, ' ').trim();
}
