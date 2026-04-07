import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function appendLog(
  logPath: string,
  operation: string,
  details: string,
): void {
  const now = new Date().toISOString().split('T')[0] ?? '';
  const time = new Date().toISOString().split('T')[1]?.substring(0, 5) ?? '';
  const entry = `\n## [${now} ${time}] ${operation}\n\n${details}\n`;

  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, existing + entry, 'utf-8');
  } else {
    writeFileSync(logPath, `---\ntitle: Wiki Log\ntype: log\n---\n\n# Wiki Log\n${entry}`, 'utf-8');
  }
}
