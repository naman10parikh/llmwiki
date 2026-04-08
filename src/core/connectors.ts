/**
 * ConnectorManager — manages folder and repo data source connections.
 * Supports: local folders, git repos (local path or remote URL).
 * Watches connected folders with chokidar, auto-triggers ingest on new/changed files.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import chokidar from 'chokidar';

export type ConnectorType = 'folder' | 'git-repo' | 'github';

export interface ConnectorConfig {
  id: string;
  type: ConnectorType;
  name: string;
  path: string;
  url?: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  autoSync?: boolean;
  syncSchedule?: string;
  createdAt: string;
  lastSyncAt?: string;
  status: 'active' | 'error' | 'syncing' | 'idle';
  errorMessage?: string;
  totalFiles?: number;
}

export interface SyncResult {
  connectorId: string;
  filesFound: number;
  filesIngested: number;
  pagesCreated: number;
  linksAdded: number;
  errors: string[];
  duration: number;
}

export class ConnectorManager extends EventEmitter {
  private connectors: Map<string, ConnectorConfig> = new Map();
  private watchers: Map<string, ReturnType<typeof chokidar.watch>> = new Map();
  private vaultRoot: string;
  private configPath: string;

  constructor(vaultRoot: string) {
    super();
    this.vaultRoot = vaultRoot;
    this.configPath = join(vaultRoot, '.wikimem-connectors.json');
    this.loadConnectors();
  }

  private loadConnectors() {
    try {
      if (existsSync(this.configPath)) {
        const data = JSON.parse(readFileSync(this.configPath, 'utf-8')) as ConnectorConfig[];
        for (const c of data) this.connectors.set(c.id, c);
      }
    } catch {}
  }

  private saveConnectors() {
    writeFileSync(this.configPath, JSON.stringify([...this.connectors.values()], null, 2));
  }

  getAll(): ConnectorConfig[] {
    return [...this.connectors.values()];
  }

  get(id: string): ConnectorConfig | undefined {
    return this.connectors.get(id);
  }

  add(config: Omit<ConnectorConfig, 'id' | 'createdAt' | 'status'>): ConnectorConfig {
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    const connector: ConnectorConfig = {
      ...config,
      id,
      createdAt: new Date().toISOString(),
      status: 'idle',
    };
    this.connectors.set(id, connector);
    this.saveConnectors();
    if (config.autoSync) this.startWatcher(connector);
    return connector;
  }

  remove(id: string): boolean {
    const c = this.connectors.get(id);
    if (!c) return false;
    this.stopWatcher(id);
    this.connectors.delete(id);
    this.saveConnectors();
    return true;
  }

  private stopWatcher(id: string) {
    const w = this.watchers.get(id);
    if (w) { void w.close(); this.watchers.delete(id); }
  }

  startWatcher(connector: ConnectorConfig) {
    if (this.watchers.has(connector.id)) return;
    if (!existsSync(connector.path)) return;

    const ignored = (connector.excludeGlobs ?? [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/*.tmp',
    ]);

    const watcher = chokidar.watch(connector.path, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000 },
    });

    watcher.on('add', (filePath: string) => {
      if (this.shouldIngest(filePath, connector)) {
        this.emit('file-detected', { connectorId: connector.id, filePath });
      }
    });

    watcher.on('change', (filePath: string) => {
      if (this.shouldIngest(filePath, connector)) {
        this.emit('file-changed', { connectorId: connector.id, filePath });
      }
    });

    this.watchers.set(connector.id, watcher);
  }

  startAllWatchers() {
    for (const c of this.connectors.values()) {
      if (c.autoSync && c.status !== 'error') {
        this.startWatcher(c);
      }
    }
  }

  private shouldIngest(filePath: string, connector: ConnectorConfig): boolean {
    const ext = extname(filePath).toLowerCase();
    const INGESTIBLE = new Set([
      '.md', '.txt', '.pdf', '.json', '.yaml', '.yml', '.csv', '.html',
      '.docx', '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.png', '.jpg', '.jpeg',
    ]);
    if (!INGESTIBLE.has(ext)) return false;

    // Check include globs if specified
    if (connector.includeGlobs?.length) {
      const { minimatch } = require('minimatch');
      return connector.includeGlobs.some((g: string) => minimatch(basename(filePath), g));
    }
    return true;
  }

  async scanFiles(connector: ConnectorConfig): Promise<string[]> {
    const files: string[] = [];
    const INGESTIBLE = new Set([
      '.md', '.txt', '.pdf', '.json', '.yaml', '.yml', '.csv', '.html',
      '.docx', '.mp3', '.wav', '.m4a', '.mp4', '.mov',
    ]);
    const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);

    const walk = (dir: string, depth: number = 0) => {
      if (depth > 5) return;
      if (!existsSync(dir)) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (IGNORED.has(entry.name)) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (INGESTIBLE.has(ext)) files.push(fullPath);
          }
        }
      } catch {}
    };

    walk(connector.path);
    return files;
  }

  /** Clone a remote git repo to the vault's connectors directory */
  async cloneRepo(url: string, targetPath: string): Promise<{ success: boolean; error?: string }> {
    const connectorsDir = join(this.vaultRoot, '.wikimem-repos');
    if (!existsSync(connectorsDir)) mkdirSync(connectorsDir, { recursive: true });

    const result = spawnSync('git', ['clone', '--depth', '1', url, targetPath], {
      encoding: 'utf-8', timeout: 60000,
    });
    if (result.status !== 0) {
      return { success: false, error: result.stderr || 'Clone failed' };
    }
    return { success: true };
  }

  updateStatus(id: string, status: ConnectorConfig['status'], extra?: Partial<ConnectorConfig>) {
    const c = this.connectors.get(id);
    if (!c) return;
    Object.assign(c, { status, ...extra });
    this.saveConnectors();
    this.emit('status-changed', { id, status, ...extra });
  }
}

// Singleton per vault
const managers = new Map<string, ConnectorManager>();

export function getConnectorManager(vaultRoot: string): ConnectorManager {
  if (!managers.has(vaultRoot)) managers.set(vaultRoot, new ConnectorManager(vaultRoot));
  return managers.get(vaultRoot)!;
}
