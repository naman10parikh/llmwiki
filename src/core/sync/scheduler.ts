/**
 * SyncScheduler — cron-based periodic sync for connected platforms.
 * Emits events: sync-start, sync-complete, sync-error.
 */
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cron from 'node-cron';

// Avoid circular dependency: index.ts re-exports from scheduler.ts,
// so we lazy-import syncProvider at runtime instead.
interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface TokenStore {
  [provider: string]: {
    access_token: string;
    refresh_token?: string;
    scope?: string;
    connectedAt?: string;
  };
}

/** Human-friendly schedule presets mapped to cron patterns */
const SCHEDULE_PRESETS: Record<string, string> = {
  'hourly': '0 * * * *',
  'every-6h': '0 */6 * * *',
  'daily': '0 9 * * *',
  'weekly': '0 9 * * 1',
};

const DEFAULT_SCHEDULE = '0 */6 * * *';

interface ScheduleEntry { provider: string; pattern: string; task: cron.ScheduledTask }

interface ConnectorConfig { id: string; type: string; syncSchedule?: string; status: string }

export class SyncScheduler extends EventEmitter {
  private jobs: Map<string, ScheduleEntry> = new Map();
  private vaultRoot: string;

  constructor(vaultRoot: string) {
    super();
    this.vaultRoot = vaultRoot;
  }

  /** Resolve a schedule string (preset name or raw cron) to a cron pattern */
  private resolveCron(schedule: string): string {
    return SCHEDULE_PRESETS[schedule] ?? schedule;
  }

  /** Schedule a provider sync on a cron pattern */
  schedule(provider: string, cronPattern: string): void {
    // Unschedule existing job for this provider
    this.unschedule(provider);

    const resolved = this.resolveCron(cronPattern);

    if (!cron.validate(resolved)) {
      console.log(`[SyncScheduler] Invalid cron pattern for ${provider}: ${resolved}`);
      return;
    }

    console.log(`[SyncScheduler] Scheduling ${provider} sync: ${resolved}`);

    const task = cron.schedule(resolved, async () => {
      await this.runSync(provider);
    }, { scheduled: true });

    this.jobs.set(provider, { provider, pattern: resolved, task });
  }

  /** Remove a scheduled sync */
  unschedule(provider: string): void {
    const existing = this.jobs.get(provider);
    if (existing) {
      existing.task.stop();
      this.jobs.delete(provider);
      console.log(`[SyncScheduler] Unscheduled ${provider} sync`);
    }
  }

  /** Get all active schedules */
  getSchedules(): Array<{ provider: string; pattern: string }> {
    const result: Array<{ provider: string; pattern: string }> = [];
    this.jobs.forEach((entry) => {
      result.push({ provider: entry.provider, pattern: entry.pattern });
    });
    return result;
  }

  /** Start all configured schedules from connector configs + OAuth tokens */
  startFromConfig(): void {
    const tokensPath = join(this.vaultRoot, '.wikimem', 'tokens.json');
    const connectorsPath = join(this.vaultRoot, '.wikimem-connectors.json');

    let tokens: TokenStore = {};
    if (existsSync(tokensPath)) {
      try { tokens = JSON.parse(readFileSync(tokensPath, 'utf-8')) as TokenStore; }
      catch { console.log('[SyncScheduler] Failed to parse tokens.json'); }
    }

    const scheduleMap = new Map<string, string>();
    if (existsSync(connectorsPath)) {
      try {
        const connectors = JSON.parse(readFileSync(connectorsPath, 'utf-8')) as ConnectorConfig[];
        for (const c of connectors) {
          if (c.syncSchedule && c.type) scheduleMap.set(c.type, c.syncSchedule);
        }
      } catch { console.log('[SyncScheduler] Failed to parse connectors config'); }
    }

    const providers = Object.keys(tokens);
    if (providers.length === 0) {
      console.log('[SyncScheduler] No OAuth tokens found — nothing to schedule');
      return;
    }
    for (const provider of providers) {
      if (!tokens[provider]?.access_token) continue;
      this.schedule(provider, scheduleMap.get(provider) ?? DEFAULT_SCHEDULE);
    }
    console.log(`[SyncScheduler] Started ${this.jobs.size} sync schedule(s)`);
  }

  /** Stop all scheduled jobs */
  stopAll(): void {
    this.jobs.forEach((entry, provider) => {
      entry.task.stop();
      console.log(`[SyncScheduler] Stopped ${provider} sync`);
    });
    this.jobs.clear();
  }

  /** Execute a sync for a provider, emitting events */
  private async runSync(provider: string): Promise<void> {
    console.log(`[SyncScheduler] Starting sync for ${provider}`);
    this.emit('sync-start', provider);

    try {
      const { syncProvider: doSync } = await import('./index.js');
      const result = await doSync(provider, this.vaultRoot);

      if (result.errors.length > 0) {
        console.log(`[SyncScheduler] ${provider} sync completed with ${result.errors.length} error(s)`);
      } else {
        console.log(`[SyncScheduler] ${provider} sync complete: ${result.filesWritten} files in ${result.duration}ms`);
      }

      this.emit('sync-complete', result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`[SyncScheduler] ${provider} sync failed: ${error.message}`);
      this.emit('sync-error', provider, error);
    }
  }
}

export { SCHEDULE_PRESETS };
