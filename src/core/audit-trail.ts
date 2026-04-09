import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: 'ingest' | 'scrape' | 'improve' | 'observe' | 'edit' | 'restore';
  actor: 'human' | 'agent' | 'webhook' | 'observer';
  source?: string;
  summary: string;
  pagesAffected: string[];
  commitHash?: string;
  duration?: number;
}

export function getAuditTrailPath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'audit-trail.jsonl');
}

export function appendAuditEntry(
  vaultRoot: string,
  entry: Omit<AuditEntry, 'id' | 'timestamp'>,
): AuditEntry {
  const dir = join(vaultRoot, '.wikimem');
  mkdirSync(dir, { recursive: true });
  const full: AuditEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  appendFileSync(getAuditTrailPath(vaultRoot), JSON.stringify(full) + '\n', 'utf-8');
  return full;
}

export function readAuditTrail(
  vaultRoot: string,
  limit = 50,
  actor?: string,
  action?: string,
): AuditEntry[] {
  const path = getAuditTrailPath(vaultRoot);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  let entries: AuditEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }

  if (actor && actor !== 'all') entries = entries.filter((e) => e.actor === actor);
  if (action && action !== 'all') entries = entries.filter((e) => e.action === action);

  // Most-recent first
  return entries.reverse().slice(0, limit);
}
