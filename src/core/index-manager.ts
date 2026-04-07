import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { VaultConfig } from './vault.js';

interface PageEntry {
  title: string;
  category: string;
  summary: string;
}

export async function updateIndex(
  config: VaultConfig,
  newPages: PageEntry[],
): Promise<void> {
  const indexPath = config.indexPath;
  let indexContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';

  for (const page of newPages) {
    const link = `- [[${page.title}]] — ${page.summary}`;
    const sectionHeader = `## ${capitalize(page.category)}`;

    if (indexContent.includes(`[[${page.title}]]`)) {
      // Update existing entry
      const regex = new RegExp(`- \\[\\[${escapeRegex(page.title)}\\]\\].*`, 'g');
      indexContent = indexContent.replace(regex, link);
    } else if (indexContent.includes(sectionHeader)) {
      // Add under existing section
      indexContent = indexContent.replace(
        sectionHeader,
        `${sectionHeader}\n${link}`,
      );
    } else {
      // Add new section
      indexContent += `\n${sectionHeader}\n${link}\n`;
    }
  }

  writeFileSync(indexPath, indexContent, 'utf-8');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
