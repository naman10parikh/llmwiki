import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface ProcessedText {
  title: string;
  content: string;
  wordCount: number;
}

export function processText(filePath: string): ProcessedText {
  const content = readFileSync(filePath, 'utf-8');
  const title = basename(filePath, extname(filePath));
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return { title, content, wordCount };
}
