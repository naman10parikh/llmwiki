import { readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

export interface ScanResult {
  files: string[];
  summary: {
    total: number;
    byType: Record<string, number>;
  };
}

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.pdf',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.mp3', '.wav', '.m4a', '.ogg', '.flac',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt',
  '.sh', '.bash', '.zsh',
  '.toml', '.ini', '.cfg', '.env',
  '.sql', '.graphql',
]);

const TYPE_LABELS: Record<string, string> = {
  '.md': 'Markdown', '.txt': 'Text', '.csv': 'CSV', '.json': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML', '.xml': 'XML', '.html': 'HTML', '.htm': 'HTML',
  '.pdf': 'PDF',
  '.docx': 'Word', '.doc': 'Word', '.xlsx': 'Excel', '.xls': 'Excel', '.pptx': 'PowerPoint', '.ppt': 'PowerPoint',
  '.jpg': 'Image', '.jpeg': 'Image', '.png': 'Image', '.gif': 'Image', '.webp': 'Image', '.svg': 'Image',
  '.mp3': 'Audio', '.wav': 'Audio', '.m4a': 'Audio', '.ogg': 'Audio', '.flac': 'Audio',
  '.mp4': 'Video', '.mov': 'Video', '.avi': 'Video', '.mkv': 'Video', '.webm': 'Video',
  '.ts': 'Code', '.js': 'Code', '.py': 'Code', '.go': 'Code', '.rs': 'Code',
  '.java': 'Code', '.c': 'Code', '.cpp': 'Code', '.h': 'Code', '.rb': 'Code',
  '.php': 'Code', '.swift': 'Code', '.kt': 'Code',
  '.sh': 'Script', '.bash': 'Script', '.zsh': 'Script',
  '.toml': 'Config', '.ini': 'Config', '.cfg': 'Config', '.env': 'Config',
  '.sql': 'SQL', '.graphql': 'GraphQL',
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store',
  '.next', '.nuxt', 'dist', 'build', '.cache', '.wikimem-cache',
  '.obsidian', '.vscode', '.idea', 'vendor', 'target',
]);

export function scanFolder(folderPath: string, maxFiles = 500): ScanResult {
  const resolved = resolve(folderPath);
  const files: string[] = [];
  const byType: Record<string, number> = {};

  function walk(dir: string, depth: number): void {
    if (depth > 10 || files.length >= maxFiles) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.startsWith('.') && entry !== '.env') continue;
        if (SKIP_DIRS.has(entry)) continue;

        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full, depth + 1);
          } else if (stat.isFile() && stat.size > 0 && stat.size < 50 * 1024 * 1024) {
            const ext = extname(entry).toLowerCase();
            if (SUPPORTED_EXTENSIONS.has(ext) || ext === '') {
              files.push(full);
              const label = TYPE_LABELS[ext] ?? 'Other';
              byType[label] = (byType[label] ?? 0) + 1;
            }
          }
        } catch {
          // Skip permission errors
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  walk(resolved, 0);
  return { files, summary: { total: files.length, byType } };
}

export function formatScanSummary(summary: ScanResult['summary']): string {
  const parts = Object.entries(summary.byType)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `${count} ${type}`);
  return `Found ${summary.total} files (${parts.join(', ')})`;
}
