import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type PipelineStep =
  | 'detect'
  | 'extract'
  | 'dedup'
  | 'copy-raw'
  | 'llm-compile'
  | 'write-pages'
  | 'update-index'
  | 'embed'
  | 'git-commit'
  | 'complete'
  | 'error';

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface PipelineEvent {
  step: PipelineStep;
  status: StepStatus;
  detail?: string;
  progress?: number;
  timestamp: string;
}

export interface LLMTrace {
  systemPrompt: string;
  userPrompt: string;
  response: string;
  model?: string;
  tokensUsed?: number;
  durationMs?: number;
}

export interface PipelineRun {
  id: string;
  source: string;
  startedAt: string;
  events: PipelineEvent[];
  llmTrace?: LLMTrace;
  summary?: PipelineSummary;
  result?: {
    pagesCreated: number;
    linksAdded: number;
    title: string;
  };
}

export interface PipelineSummary {
  whatHappened: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  entitiesFound: string[];
  conceptsFound: string[];
  linksCreated: number;
  decisionsExplained: string;
}

const MAX_PERSISTED_RUNS = 50;

class PipelineEventBus extends EventEmitter {
  private currentRun: PipelineRun | null = null;
  private runs: PipelineRun[] = [];
  private persistPath: string | null = null;

  /**
   * Enable file-based persistence so runs survive server restarts.
   * Call once at startup with the vault root path.
   */
  initPersistence(vaultRoot: string): void {
    this.persistPath = join(vaultRoot, '.wikimem', 'pipeline-runs.json');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PipelineRun[];
      if (Array.isArray(data)) {
        this.runs = data.slice(-MAX_PERSISTED_RUNS);
      }
    } catch {
      // Corrupted file — start fresh, the next save will overwrite
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Strip LLM trace prompts/responses from persisted data to keep file small
      const slim = this.runs.map(r => ({
        ...r,
        llmTrace: r.llmTrace
          ? { model: r.llmTrace.model, tokensUsed: r.llmTrace.tokensUsed, durationMs: r.llmTrace.durationMs }
          : undefined,
      }));
      writeFileSync(this.persistPath, JSON.stringify(slim, null, 2), 'utf-8');
    } catch {
      // Non-fatal — runs are still in memory for the current session
    }
  }

  startRun(source: string): string {
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    this.currentRun = {
      id,
      source,
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.runs.push(this.currentRun);
    if (this.runs.length > MAX_PERSISTED_RUNS) this.runs.shift();
    this.emit('step', { step: 'run-start', status: 'running', source, id, timestamp: new Date().toISOString() });
    return id;
  }

  emitStep(step: PipelineStep, status: StepStatus, detail?: string): void {
    const event: PipelineEvent = {
      step,
      status,
      detail,
      timestamp: new Date().toISOString(),
    };
    if (this.currentRun) {
      this.currentRun.events.push(event);
    }
    this.emit('step', event);
  }

  setLLMTrace(trace: LLMTrace): void {
    if (this.currentRun) {
      this.currentRun.llmTrace = trace;
      this.emit('step', { step: 'llm-compile', status: 'done', detail: `LLM responded (${trace.durationMs ?? 0}ms)`, timestamp: new Date().toISOString() });
    }
  }

  setSummary(summary: PipelineSummary): void {
    if (this.currentRun) {
      this.currentRun.summary = summary;
    }
  }

  completeRun(result?: PipelineRun['result']): void {
    if (this.currentRun) {
      this.currentRun.result = result;
      // Emit an enriched complete event that the UI can use without a follow-up fetch:
      //   { step, status, detail, runId, pagesCreated (number), linksAdded, title, pages (string[]) }
      const pagesList =
        this.currentRun.summary?.pagesCreated && this.currentRun.summary.pagesCreated.length
          ? this.currentRun.summary.pagesCreated
          : this.currentRun.summary?.pagesUpdated ?? [];
      const entities = this.currentRun.summary?.entitiesFound ?? [];
      const concepts = this.currentRun.summary?.conceptsFound ?? [];
      this.emit('step', {
        step: 'complete',
        status: 'done',
        detail: result ? `Created ${result.pagesCreated} pages` : undefined,
        runId: this.currentRun.id,
        pagesCreated: result?.pagesCreated ?? pagesList.length,
        linksAdded: result?.linksAdded ?? 0,
        title: result?.title ?? '',
        pages: pagesList,
        entities,
        concepts,
        timestamp: new Date().toISOString(),
      });
      const evt: PipelineEvent = {
        step: 'complete',
        status: 'done',
        detail: result ? `Created ${result.pagesCreated} pages` : undefined,
        timestamp: new Date().toISOString(),
      };
      this.currentRun.events.push(evt);
    }
    this.currentRun = null;
    this.saveToDisk();
  }

  errorRun(error: string, failedStep?: PipelineStep): void {
    const errEvent: PipelineEvent & { failedStep?: PipelineStep; runId?: string } = {
      step: 'error',
      status: 'error',
      detail: error,
      timestamp: new Date().toISOString(),
    };
    if (failedStep) errEvent.failedStep = failedStep;
    if (this.currentRun) {
      errEvent.runId = this.currentRun.id;
      this.currentRun.events.push({ step: 'error', status: 'error', detail: error, timestamp: errEvent.timestamp });
    }
    this.emit('step', errEvent);
    this.currentRun = null;
    this.saveToDisk();
  }

  getRecentRuns(): PipelineRun[] {
    return [...this.runs].reverse();
  }

  getCurrentRun(): PipelineRun | null {
    return this.currentRun;
  }
}

export const pipelineEvents = new PipelineEventBus();
