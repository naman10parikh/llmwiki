import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { bm25Search } from './bm25.js';

export function searchPages(query: string, pagePaths: string[]): string[] {
  const documents = pagePaths.map((path) => {
    try {
      const content = readFileSync(path, 'utf-8');
      const title = basename(path, extname(path));
      return { path, content, title };
    } catch {
      return { path, content: '', title: basename(path) };
    }
  });

  const results = bm25Search(query, documents);
  return results.map((r) => r.path);
}
