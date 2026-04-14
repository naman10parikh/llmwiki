import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Known install locations for the Claude Code CLI binary. */
const CLAUDE_SEARCH_PATHS = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  `${process.env['HOME']}/.claude/local/claude`,
  `${process.env['HOME']}/.local/bin/claude`,
  `${process.env['HOME']}/.npm-global/bin/claude`,
];

/** Options for `runWithClaudeCode`. */
export interface ClaudeCodeOptions {
  /** Timeout in milliseconds (default: 120_000 = 2 min). */
  timeoutMs?: number;
  /**
   * When true, parse the CLI output as JSON.
   * Strips any markdown code fences before parsing.
   */
  json?: boolean;
  /** Extra CLI flags appended to the command. */
  extraArgs?: string[];
}

/** Aggregated cost info for a Claude Code CLI call. */
export interface ClaudeCodeCostInfo {
  /**
   * Claude Code uses the caller's Max/Pro subscription — no per-token API cost.
   * This field tracks the *number* of calls so the caller can gauge usage.
   */
  callCount: number;
  /** Wall-clock duration of the CLI call in milliseconds. */
  durationMs: number;
}

// ─── Module-level cost tracking ──────────────────────────────────────────────

let _totalCalls = 0;
let _totalDurationMs = 0;

/** Return aggregate cost info for all Claude Code calls in this process. */
export function getClaudeCodeCostInfo(): ClaudeCodeCostInfo {
  return { callCount: _totalCalls, durationMs: _totalDurationMs };
}

/** Reset the aggregate cost counters (useful for tests). */
export function resetClaudeCodeCostInfo(): void {
  _totalCalls = 0;
  _totalDurationMs = 0;
}

// ─── Binary discovery ────────────────────────────────────────────────────────

function findClaudeBinary(): string | null {
  try {
    const result = execFileSync('which', ['claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const path = result.trim();
    if (path) return path;
  } catch {
    // `which` failed — check known paths
  }

  for (const p of CLAUDE_SEARCH_PATHS) {
    if (existsSync(p)) return p;
  }

  return null;
}

export function isClaudeCodeAvailable(): boolean {
  return findClaudeBinary() !== null;
}

export function getClaudeCodePath(): string | null {
  return findClaudeBinary();
}

// ─── JSON helpers ────────────────────────────────────────────────────────────

/**
 * Strip markdown code fences (```json ... ```) and parse JSON.
 * Returns `null` if the input cannot be parsed.
 */
function tryParseJson(raw: string): unknown {
  let cleaned = raw.trim();

  // Strip leading ```json / ``` fences
  const fenceStart = /^```(?:json)?\s*\n?/i;
  const fenceEnd = /\n?```\s*$/;
  if (fenceStart.test(cleaned) && fenceEnd.test(cleaned)) {
    cleaned = cleaned.replace(fenceStart, '').replace(fenceEnd, '').trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ─── Main API ────────────────────────────────────────────────────────────────

/**
 * Run a prompt through the Claude Code CLI (`claude -p`).
 *
 * Uses the caller's existing Claude Code subscription — **no API key needed**.
 *
 * @param systemPrompt — injected via `--system-prompt`
 * @param userPrompt   — the `-p` prompt text
 * @param opts         — timeout, JSON parsing, extra args
 * @returns            — the raw text output (or parsed JSON when `opts.json`)
 */
export async function runWithClaudeCode(
  systemPrompt: string,
  userPrompt: string,
  opts?: ClaudeCodeOptions,
): Promise<string> {
  const binary = findClaudeBinary();
  if (!binary) {
    throw new Error(
      'Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code ' +
        'or switch LLM mode to "Direct API" in settings.',
    );
  }

  const timeoutMs = opts?.timeoutMs ?? 120_000;

  const args = [
    '-p', userPrompt,
    '--output-format', 'text',
    ...(systemPrompt ? ['--system-prompt', systemPrompt] : []),
    '--max-turns', '1',
    '--tools', '',
    ...(opts?.extraArgs ?? []),
  ];

  const startMs = Date.now();

  const text = await new Promise<string>((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || err.message.includes('ETIMEDOUT')) {
        reject(new Error(`Claude Code CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
      } else {
        reject(new Error(`Failed to spawn Claude Code CLI: ${err.message}`));
      }
    });

    // Manual timeout fallback (child_process timeout kills SIGTERM, but
    // doesn't always fire the 'error' event on all Node versions).
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Claude Code CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs + 5000); // grace period after process-level timeout

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `Claude Code CLI exited with code ${code}:\n${stderr || stdout}`,
          ),
        );
      }
    });
  });

  const durationMs = Date.now() - startMs;
  _totalCalls++;
  _totalDurationMs += durationMs;

  // JSON mode: validate that the output is parseable
  if (opts?.json) {
    const parsed = tryParseJson(text);
    if (parsed === null) {
      throw new Error(
        'Claude Code returned non-JSON output when JSON mode was requested.\n' +
          `Raw output (first 500 chars): ${text.substring(0, 500)}`,
      );
    }
    // Return the *cleaned* JSON string for downstream consumers
    return JSON.stringify(parsed);
  }

  return text;
}

/**
 * Backwards-compatible alias — existing callers in the codebase import this name.
 */
export const runClaudeCode = runWithClaudeCode;
