import { EventEmitter } from 'node:events';

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

class PipelineEventBus extends EventEmitter {
  private currentRun: PipelineRun | null = null;
  private runs: PipelineRun[] = [];

  startRun(source: string): string {
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    this.currentRun = {
      id,
      source,
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.runs.push(this.currentRun);
    if (this.runs.length > 20) this.runs.shift();
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
      this.emitStep('complete', 'done', result ? `Created ${result.pagesCreated} pages` : undefined);
    }
    this.currentRun = null;
  }

  errorRun(error: string): void {
    this.emitStep('error', 'error', error);
    this.currentRun = null;
  }

  getRecentRuns(): PipelineRun[] {
    return [...this.runs].reverse();
  }

  getCurrentRun(): PipelineRun | null {
    return this.currentRun;
  }
}

export const pipelineEvents = new PipelineEventBus();
