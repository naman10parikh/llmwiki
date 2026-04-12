import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CLAUDE_SEARCH_PATHS = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  `${process.env['HOME']}/.claude/local/claude`,
  `${process.env['HOME']}/.local/bin/claude`,
  `${process.env['HOME']}/.npm-global/bin/claude`,
];

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

/**
 * Run a prompt through the Claude Code CLI (`claude -p`).
 * Uses the caller's existing Claude Code subscription — no API key needed.
 */
export async function runClaudeCode(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const binary = findClaudeBinary();
  if (!binary) {
    throw new Error(
      'Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code ' +
        'or switch LLM mode to "Direct API" in settings.',
    );
  }

  const args = [
    '-p', userPrompt,
    '--output-format', 'text',
    '--system-prompt', systemPrompt,
    '--max-turns', '1',
  ];

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 300_000,
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
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.on('close', (code) => {
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
}
