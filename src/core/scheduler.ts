/**
 * Central Automation Scheduler
 *
 * Manages all three automation loops:
 *   1. Connector Sync — periodic connector/provider ingestion
 *   2. Pipeline Watcher — watch raw/ for new files, auto-ingest
 *   3. Observer — nightly quality scan + self-improvement
 *
 * Each automation is independently schedulable and toggleable.
 * Logs all runs to .wikimem/automation-log.jsonl.
 * Emits SSE-friendly events for the web UI.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import cron from 'node-cron';
import type { VaultConfig } from './vault.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AutomationId = 'connector-sync' | 'pipeline-watcher' | 'observer';

export type AutomationStatus = 'idle' | 'running' | 'error' | 'disabled';

export type SchedulePreset = 'hourly' | 'every-6h' | 'daily' | 'weekly' | 'custom';

export interface AutomationState {
  id: AutomationId;
  name: string;
  description: string;
  enabled: boolean;
  status: AutomationStatus;
  schedule: string;
  schedulePreset: SchedulePreset;
  lastRunAt: string | null;
  lastRunDuration: number | null;
  lastRunResult: 'success' | 'error' | null;
  lastRunError: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  totalErrors: number;
  estimatedCostPerRun: number;
  totalCostEstimate: number;
}

export interface AutomationRunLog {
  id: AutomationId;
  startedAt: string;
  finishedAt: string;
  duration: number;
  result: 'success' | 'error';
  error?: string;
  details?: Record<string, unknown>;
  estimatedCost: number;
}

export interface AutomationEvent {
  type: 'automation-status';
  automationId: AutomationId;
  status: AutomationStatus;
  timestamp: string;
  detail?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SCHEDULE_PRESETS: Record<string, string> = {
  'hourly': '0 * * * *',
  'every-6h': '0 */6 * * *',
  'daily': '0 3 * * *',
  'weekly': '0 3 * * 1',
};

const COST_ESTIMATES: Record<AutomationId, number> = {
  'connector-sync': 0.0,
  'pipeline-watcher': 0.05,
  'observer': 0.15,
};

const AUTOMATION_DEFAULTS: Record<AutomationId, { name: string; description: string; schedule: string; preset: SchedulePreset }> = {
  'connector-sync': {
    name: 'Connector Sync',
    description: 'Auto-sync connected platforms (Slack, GitHub, RSS, etc.) on a schedule',
    schedule: '0 */6 * * *',
    preset: 'every-6h',
  },
  'pipeline-watcher': {
    name: 'Pipeline Watcher',
    description: 'Watch raw/ for new files and auto-process through the ingest pipeline',
    schedule: '* * * * *',
    preset: 'custom',
  },
  'observer': {
    name: 'Observer',
    description: 'Quality scan, orphan detection, gap analysis, and auto-improvement of wiki pages',
    schedule: '0 3 * * *',
    preset: 'daily',
  },
};

const ALL_IDS: AutomationId[] = ['connector-sync', 'pipeline-watcher', 'observer'];

// ─── Persistence ─────────────────────────────────────────────────────────────

interface PersistedState {
  automations: Record<string, {
    enabled: boolean;
    schedule: string;
    schedulePreset: SchedulePreset;
    totalRuns: number;
    totalErrors: number;
    totalCostEstimate: number;
    lastRunAt: string | null;
    lastRunResult: 'success' | 'error' | null;
  }>;
}

function getStatePath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'scheduler-state.json');
}

function getLogPath(vaultRoot: string): string {
  return join(vaultRoot, '.wikimem', 'automation-log.jsonl');
}

function loadPersistedState(vaultRoot: string): PersistedState | null {
  const p = getStatePath(vaultRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as PersistedState;
  } catch {
    return null;
  }
}

function savePersistedState(vaultRoot: string, state: PersistedState): void {
  const dir = join(vaultRoot, '.wikimem');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getStatePath(vaultRoot), JSON.stringify(state, null, 2), 'utf-8');
}

function appendRunLog(vaultRoot: string, log: AutomationRunLog): void {
  const dir = join(vaultRoot, '.wikimem');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(getLogPath(vaultRoot), JSON.stringify(log) + '\n', 'utf-8');
}

function readRunLogs(vaultRoot: string, automationId?: AutomationId, limit?: number): AutomationRunLog[] {
  const p = getLogPath(vaultRoot);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
    let logs = lines.map(line => JSON.parse(line) as AutomationRunLog);
    if (automationId) {
      logs = logs.filter(l => l.id === automationId);
    }
    logs.reverse();
    if (limit && limit > 0) {
      logs = logs.slice(0, limit);
    }
    return logs;
  } catch {
    return [];
  }
}

// ─── Scheduler Class ─────────────────────────────────────────────────────────

export class AutomationScheduler extends EventEmitter {
  private states: Map<AutomationId, AutomationState> = new Map();
  private cronJobs: Map<AutomationId, ReturnType<typeof cron.schedule>> = new Map();
  private vaultRoot: string;
  private config: VaultConfig;
  private watcherCleanup: (() => void) | null = null;
  private running: Set<AutomationId> = new Set();

  constructor(config: VaultConfig) {
    super();
    this.config = config;
    this.vaultRoot = config.root;
    this.initStates();
  }

  private initStates(): void {
    const persisted = loadPersistedState(this.vaultRoot);

    for (const id of ALL_IDS) {
      const defaults = AUTOMATION_DEFAULTS[id];
      const saved = persisted?.automations[id];

      const state: AutomationState = {
        id,
        name: defaults.name,
        description: defaults.description,
        enabled: saved?.enabled ?? true,
        status: 'idle',
        schedule: saved?.schedule ?? defaults.schedule,
        schedulePreset: saved?.schedulePreset ?? defaults.preset,
        lastRunAt: saved?.lastRunAt ?? null,
        lastRunDuration: null,
        lastRunResult: saved?.lastRunResult ?? null,
        lastRunError: null,
        nextRunAt: null,
        totalRuns: saved?.totalRuns ?? 0,
        totalErrors: saved?.totalErrors ?? 0,
        estimatedCostPerRun: COST_ESTIMATES[id],
        totalCostEstimate: saved?.totalCostEstimate ?? 0,
      };

      this.states.set(id, state);
    }
  }

  private persist(): void {
    const automations: PersistedState['automations'] = {};
    for (const [id, state] of this.states) {
      automations[id] = {
        enabled: state.enabled,
        schedule: state.schedule,
        schedulePreset: state.schedulePreset,
        totalRuns: state.totalRuns,
        totalErrors: state.totalErrors,
        totalCostEstimate: state.totalCostEstimate,
        lastRunAt: state.lastRunAt,
        lastRunResult: state.lastRunResult,
      };
    }
    savePersistedState(this.vaultRoot, { automations });
  }

  private emitAutomationEvent(id: AutomationId, status: AutomationStatus, detail?: string): void {
    const event: AutomationEvent = {
      type: 'automation-status',
      automationId: id,
      status,
      timestamp: new Date().toISOString(),
      detail,
    };
    this.emit('automation-event', event);
  }

  private computeNextRun(schedule: string): string | null {
    // For the pipeline watcher running every minute, just return +1m
    // For cron patterns, compute the next occurrence
    try {
      if (!cron.validate(schedule)) return null;
      // Simple estimation: parse the cron and compute next tick
      // node-cron does not expose a "next occurrence" API, so we estimate
      const parts = schedule.split(' ');
      const now = new Date();

      const minute = parts[0];
      const hour = parts[1];

      if (minute === '*' && hour === '*') {
        // Runs every minute
        const next = new Date(now.getTime() + 60_000);
        return next.toISOString();
      }

      if (minute !== '*' && hour === '*') {
        // Runs at a specific minute each hour
        const next = new Date(now);
        const targetMin = parseInt(minute ?? '0', 10);
        if (now.getMinutes() >= targetMin) {
          next.setHours(next.getHours() + 1);
        }
        next.setMinutes(targetMin, 0, 0);
        return next.toISOString();
      }

      if (hour !== '*' && minute !== '*') {
        // Runs at a specific time
        const next = new Date(now);
        const targetHour = parseInt(hour ?? '0', 10);
        const targetMin = parseInt(minute ?? '0', 10);
        next.setHours(targetHour, targetMin, 0, 0);
        if (next <= now) {
          next.setDate(next.getDate() + 1);
        }
        return next.toISOString();
      }

      // Fallback: approximate by checking every-N-hour patterns
      if (hour?.startsWith('*/')) {
        const interval = parseInt(hour.slice(2), 10);
        const targetMin = parseInt(minute ?? '0', 10);
        const next = new Date(now);
        next.setMinutes(targetMin, 0, 0);
        const currentH = now.getHours();
        const nextH = Math.ceil((currentH + 1) / interval) * interval;
        next.setHours(nextH >= 24 ? nextH - 24 : nextH);
        if (next <= now) {
          next.setHours(next.getHours() + interval);
        }
        return next.toISOString();
      }

      return null;
    } catch {
      return null;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Get all automation states */
  getAll(): AutomationState[] {
    return ALL_IDS.map(id => {
      const state = this.states.get(id)!;
      return { ...state };
    });
  }

  /** Get one automation state */
  getOne(id: AutomationId): AutomationState | undefined {
    const state = this.states.get(id);
    return state ? { ...state } : undefined;
  }

  /** Update schedule and/or enabled state */
  update(id: AutomationId, opts: { schedule?: string; schedulePreset?: SchedulePreset; enabled?: boolean }): AutomationState | undefined {
    const state = this.states.get(id);
    if (!state) return undefined;

    if (opts.enabled !== undefined) {
      state.enabled = opts.enabled;
      if (!opts.enabled) {
        state.status = 'disabled';
        this.stopCronJob(id);
        this.emitAutomationEvent(id, 'disabled', 'Disabled by user');
      } else {
        state.status = 'idle';
        this.startCronJob(id);
        this.emitAutomationEvent(id, 'idle', 'Enabled by user');
      }
    }

    if (opts.schedule) {
      const resolved = SCHEDULE_PRESETS[opts.schedule] ?? opts.schedule;
      if (cron.validate(resolved) || id === 'pipeline-watcher') {
        state.schedule = resolved;
        state.schedulePreset = opts.schedulePreset ?? 'custom';
        state.nextRunAt = this.computeNextRun(resolved);
        // Restart cron with new schedule
        if (state.enabled) {
          this.stopCronJob(id);
          this.startCronJob(id);
        }
      }
    }

    this.persist();
    return { ...state };
  }

  /** Trigger a manual run (ignores schedule, respects enabled check only loosely) */
  async triggerRun(id: AutomationId): Promise<AutomationRunLog> {
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Unknown automation: ${id}`);
    }
    if (this.running.has(id)) {
      throw new Error(`${id} is already running`);
    }

    return this.executeRun(id);
  }

  /** Get run history for an automation */
  getRunLogs(id: AutomationId, limit = 50): AutomationRunLog[] {
    return readRunLogs(this.vaultRoot, id, limit);
  }

  /** Start all enabled automations */
  startAll(): void {
    for (const id of ALL_IDS) {
      const state = this.states.get(id);
      if (state?.enabled) {
        this.startCronJob(id);
      }
    }
    console.log(`  Automation scheduler started (${this.cronJobs.size} active)`);
  }

  /** Stop everything */
  stopAll(): void {
    for (const id of ALL_IDS) {
      this.stopCronJob(id);
    }
    if (this.watcherCleanup) {
      this.watcherCleanup();
      this.watcherCleanup = null;
    }
  }

  // ─── Cron Management ──────────────────────────────────────────────────────

  private startCronJob(id: AutomationId): void {
    this.stopCronJob(id);
    const state = this.states.get(id);
    if (!state || !state.enabled) return;

    // Pipeline watcher uses chokidar, not cron
    if (id === 'pipeline-watcher') {
      this.startPipelineWatcher();
      state.status = 'idle';
      state.nextRunAt = null; // event-driven, no next run
      this.emitAutomationEvent(id, 'idle', 'File watcher active');
      return;
    }

    if (!cron.validate(state.schedule)) {
      console.log(`[scheduler] Invalid cron for ${id}: ${state.schedule}`);
      return;
    }

    const job = cron.schedule(state.schedule, () => {
      void this.executeRun(id);
    }, { scheduled: true });

    this.cronJobs.set(id, job);
    state.nextRunAt = this.computeNextRun(state.schedule);
    console.log(`  Scheduled ${state.name}: ${state.schedule}`);
  }

  private stopCronJob(id: AutomationId): void {
    const existing = this.cronJobs.get(id);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(id);
    }
    if (id === 'pipeline-watcher' && this.watcherCleanup) {
      this.watcherCleanup();
      this.watcherCleanup = null;
    }
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  private async executeRun(id: AutomationId): Promise<AutomationRunLog> {
    const state = this.states.get(id)!;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    this.running.add(id);
    state.status = 'running';
    this.emitAutomationEvent(id, 'running');

    let result: 'success' | 'error' = 'success';
    let error: string | undefined;
    let details: Record<string, unknown> | undefined;

    try {
      switch (id) {
        case 'connector-sync':
          details = await this.runConnectorSync();
          break;
        case 'observer':
          details = await this.runObserver();
          break;
        case 'pipeline-watcher':
          // Pipeline watcher is event-driven; manual trigger scans raw/ once
          details = await this.runPipelineScan();
          break;
      }
    } catch (err) {
      result = 'error';
      error = err instanceof Error ? err.message : String(err);
    }

    const duration = Date.now() - startMs;
    const finishedAt = new Date().toISOString();
    const estimatedCost = COST_ESTIMATES[id];

    state.status = result === 'success' ? 'idle' : 'error';
    state.lastRunAt = finishedAt;
    state.lastRunDuration = duration;
    state.lastRunResult = result;
    state.lastRunError = error ?? null;
    state.totalRuns++;
    if (result === 'error') state.totalErrors++;
    state.totalCostEstimate += estimatedCost;
    state.nextRunAt = this.computeNextRun(state.schedule);

    this.running.delete(id);
    this.persist();

    const log: AutomationRunLog = {
      id,
      startedAt,
      finishedAt,
      duration,
      result,
      error,
      details,
      estimatedCost,
    };
    appendRunLog(this.vaultRoot, log);

    this.emitAutomationEvent(id, state.status, result === 'error' ? error : `Completed in ${duration}ms`);

    return log;
  }

  // ─── Automation Runners ─────────────────────────────────────────────────────

  private async runConnectorSync(): Promise<Record<string, unknown>> {
    const { SyncScheduler } = await import('./sync/index.js');
    const scheduler = new SyncScheduler(this.vaultRoot);

    // Run an immediate sync for all connected providers
    const tokensPath = join(this.vaultRoot, '.wikimem', 'tokens.json');
    if (!existsSync(tokensPath)) {
      return { providers: 0, note: 'No OAuth tokens found' };
    }

    let tokens: Record<string, unknown> = {};
    try {
      tokens = JSON.parse(readFileSync(tokensPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return { providers: 0, note: 'Failed to parse tokens.json' };
    }

    const providers = Object.keys(tokens);
    const results: Array<{ provider: string; filesWritten: number; errors: number }> = [];

    const { syncProvider } = await import('./sync/index.js');
    for (const provider of providers) {
      try {
        const syncResult = await syncProvider(provider, this.vaultRoot);
        results.push({ provider, filesWritten: syncResult.filesWritten, errors: syncResult.errors.length });
      } catch (err) {
        results.push({ provider, filesWritten: 0, errors: 1 });
      }
    }

    return { providers: providers.length, results };
  }

  private async runObserver(): Promise<Record<string, unknown>> {
    const { loadConfig } = await import('./config.js');
    const userConfig = loadConfig(this.config.configPath);

    // Check if claude-code mode is configured
    if (userConfig.llm_mode === 'claude-code') {
      const { isClaudeCodeAvailable, runWithClaudeCode } = await import('./claude-code.js');
      if (isClaudeCodeAvailable()) {
        const output = await runWithClaudeCode(
          'You are a wiki quality observer. Score pages, find orphans, flag contradictions, identify gaps.',
          `Run the observer quality scan on the wiki at ${this.vaultRoot}. Score all pages, find orphans, flag contradictions, identify knowledge gaps. Auto-improve the 3 weakest pages.`,
          { timeoutMs: 120_000 },
        );
        return { mode: 'claude-code', output: output.slice(0, 500) };
      }
    }

    const { runObserver } = await import('./observer.js');
    const report = await runObserver(this.config, {
      autoImprove: true,
      maxImprovements: 3,
      maxBudget: 2.0,
    });

    return {
      totalPages: report.totalPages,
      pagesReviewed: report.pagesReviewed,
      averageScore: report.averageScore,
      orphans: report.orphans.length,
      gaps: report.gaps.length,
      contradictions: report.contradictions.length,
      improvements: report.improvements.filter(i => i.improved).length,
    };
  }

  private async runPipelineScan(): Promise<Record<string, unknown>> {
    // One-shot scan of raw/ for any un-ingested files
    const rawDir = this.config.rawDir;
    if (!existsSync(rawDir)) {
      return { filesFound: 0 };
    }

    const INGESTIBLE = new Set(['.md', '.txt', '.pdf', '.json', '.yaml', '.yml', '.csv', '.html', '.docx', '.mp3', '.wav', '.m4a', '.mp4', '.mov']);
    const files: string[] = [];

    const scanDir = (dir: string, depth = 0): void => {
      if (depth > 5) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name.endsWith('.meta.json')) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(full, depth + 1);
          } else {
            const ext = extname(entry.name).toLowerCase();
            if (INGESTIBLE.has(ext)) files.push(full);
          }
        }
      } catch { /* skip unreadable */ }
    };

    scanDir(rawDir);

    if (files.length === 0) {
      return { filesFound: 0 };
    }

    const { ingestSource } = await import('./ingest.js');
    const { createProviderFromUserConfig } = await import('../providers/index.js');
    const { loadConfig } = await import('./config.js');
    const userConfig = loadConfig(this.config.configPath);
    const provider = createProviderFromUserConfig(userConfig);

    let ingested = 0;
    let errors = 0;
    for (const file of files) {
      try {
        const result = await ingestSource(file, this.config, provider, { verbose: false });
        if (!result.rejected) ingested++;
      } catch {
        errors++;
      }
    }

    return { filesFound: files.length, ingested, errors };
  }

  // ─── Pipeline Watcher (chokidar) ──────────────────────────────────────────

  private startPipelineWatcher(): void {
    if (this.watcherCleanup) return;

    const rawDir = this.config.rawDir;
    if (!existsSync(rawDir)) {
      mkdirSync(rawDir, { recursive: true });
    }

    // Lazy import chokidar to avoid top-level dep
    void import('chokidar').then((chokidarModule) => {
      const INGESTIBLE = new Set([
        '.md', '.txt', '.pdf', '.json', '.yaml', '.yml', '.csv', '.html',
        '.docx', '.mp3', '.wav', '.m4a', '.mp4', '.mov',
      ]);

      const watcher = chokidarModule.watch(rawDir, {
        ignored: ['**/.git/**', '**/*.tmp', '**/*.meta.json'],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 1500 },
      });

      watcher.on('add', (filePath: string) => {
        const ext = extname(filePath).toLowerCase();
        if (!INGESTIBLE.has(ext)) return;

        console.log(`[scheduler:watcher] New file: ${basename(filePath)}`);
        this.emitAutomationEvent('pipeline-watcher', 'running', `Processing ${basename(filePath)}`);

        void (async () => {
          const state = this.states.get('pipeline-watcher')!;
          const startMs = Date.now();

          try {
            const { ingestSource } = await import('./ingest.js');
            const { createProviderFromUserConfig } = await import('../providers/index.js');
            const { loadConfig } = await import('./config.js');
            const userConfig = loadConfig(this.config.configPath);
            const provider = createProviderFromUserConfig(userConfig);
            const result = await ingestSource(filePath, this.config, provider, { verbose: false });

            const duration = Date.now() - startMs;
            state.lastRunAt = new Date().toISOString();
            state.lastRunDuration = duration;
            state.lastRunResult = 'success';
            state.lastRunError = null;
            state.totalRuns++;
            state.totalCostEstimate += COST_ESTIMATES['pipeline-watcher'];
            state.status = 'idle';

            appendRunLog(this.vaultRoot, {
              id: 'pipeline-watcher',
              startedAt: new Date(startMs).toISOString(),
              finishedAt: new Date().toISOString(),
              duration,
              result: 'success',
              details: { file: basename(filePath), title: result.title, pagesUpdated: result.pagesUpdated },
              estimatedCost: COST_ESTIMATES['pipeline-watcher'],
            });

            this.persist();
            this.emitAutomationEvent('pipeline-watcher', 'idle', `Ingested ${basename(filePath)}`);
          } catch (err) {
            const duration = Date.now() - startMs;
            const errorMsg = err instanceof Error ? err.message : String(err);

            state.lastRunAt = new Date().toISOString();
            state.lastRunDuration = duration;
            state.lastRunResult = 'error';
            state.lastRunError = errorMsg;
            state.totalRuns++;
            state.totalErrors++;
            state.status = 'error';

            appendRunLog(this.vaultRoot, {
              id: 'pipeline-watcher',
              startedAt: new Date(startMs).toISOString(),
              finishedAt: new Date().toISOString(),
              duration,
              result: 'error',
              error: errorMsg,
              details: { file: basename(filePath) },
              estimatedCost: 0,
            });

            this.persist();
            this.emitAutomationEvent('pipeline-watcher', 'error', errorMsg);
          }
        })();
      });

      this.watcherCleanup = () => {
        void watcher.close();
      };

      console.log(`  Pipeline watcher active: ${rawDir}`);
    }).catch((err) => {
      console.error('[scheduler] Failed to start pipeline watcher:', err);
    });
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: AutomationScheduler | null = null;

export function getAutomationScheduler(config: VaultConfig): AutomationScheduler {
  if (!instance) {
    instance = new AutomationScheduler(config);
  }
  return instance;
}

export function isValidAutomationId(id: string): id is AutomationId {
  return ALL_IDS.includes(id as AutomationId);
}
