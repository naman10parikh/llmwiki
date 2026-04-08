import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { VaultConfig } from './vault.js';
import { listWikiPages } from './vault.js';

export interface HistoryEntry {
  id: string;
  timestamp: string;
  automation: 'ingest' | 'scrape' | 'improve' | 'manual' | 'restore';
  summary: string;
  filesChanged: string[];
  details?: string;
}

export interface HistoryLog {
  entries: HistoryEntry[];
}

function historyDir(config: VaultConfig): string {
  return join(config.root, '.wikimem', 'history');
}

function historyLogPath(config: VaultConfig): string {
  return join(historyDir(config), 'log.json');
}

function snapshotDir(config: VaultConfig, id: string): string {
  return join(historyDir(config), 'snapshots', id);
}

export function ensureHistory(config: VaultConfig): void {
  const dir = historyDir(config);
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  if (!existsSync(historyLogPath(config))) {
    writeFileSync(historyLogPath(config), JSON.stringify({ entries: [] }, null, 2), 'utf-8');
  }
}

export function readHistoryLog(config: VaultConfig): HistoryLog {
  ensureHistory(config);
  try {
    return JSON.parse(readFileSync(historyLogPath(config), 'utf-8')) as HistoryLog;
  } catch {
    return { entries: [] };
  }
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `${ts}-${rand}`;
}

export function recordSnapshot(
  config: VaultConfig,
  automation: HistoryEntry['automation'],
  summary: string,
  details?: string,
): HistoryEntry {
  ensureHistory(config);

  const id = generateId();
  const snapDir = snapshotDir(config, id);
  mkdirSync(snapDir, { recursive: true });

  const wikiPages = listWikiPages(config.wikiDir);
  const filesChanged: string[] = [];

  for (const pagePath of wikiPages) {
    const rel = relative(config.wikiDir, pagePath);
    const destPath = join(snapDir, rel);
    const destDir = join(destPath, '..');
    mkdirSync(destDir, { recursive: true });
    try {
      cpSync(pagePath, destPath);
      filesChanged.push(rel);
    } catch {
      // Skip unreadable files
    }
  }

  // Also snapshot index.md and log.md
  for (const special of [config.indexPath, config.logPath]) {
    if (existsSync(special)) {
      const rel = relative(config.root, special);
      const destPath = join(snapDir, rel);
      const destDir = join(destPath, '..');
      mkdirSync(destDir, { recursive: true });
      cpSync(special, destPath);
    }
  }

  const entry: HistoryEntry = {
    id,
    timestamp: new Date().toISOString(),
    automation,
    summary,
    filesChanged,
    details,
  };

  const log = readHistoryLog(config);
  log.entries.push(entry);
  writeFileSync(historyLogPath(config), JSON.stringify(log, null, 2), 'utf-8');

  return entry;
}

export function restoreSnapshot(config: VaultConfig, snapshotId: string): { restored: boolean; message: string } {
  const snapDir = snapshotDir(config, snapshotId);
  if (!existsSync(snapDir)) {
    return { restored: false, message: `Snapshot ${snapshotId} not found` };
  }

  recordSnapshot(config, 'restore', `Pre-restore backup before restoring to ${snapshotId}`);

  const wikiDir = config.wikiDir;
  function clearDir(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        clearDir(full);
      } else {
        rmSync(full);
      }
    }
  }
  clearDir(wikiDir);

  cpSync(snapDir, config.root, { recursive: true });

  recordSnapshot(config, 'restore', `Restored wiki to snapshot ${snapshotId}`);

  return { restored: true, message: `Wiki restored to snapshot ${snapshotId}` };
}

export function listSnapshots(config: VaultConfig): HistoryEntry[] {
  const log = readHistoryLog(config);
  return log.entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
