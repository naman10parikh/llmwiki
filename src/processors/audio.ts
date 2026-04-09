import { execSync, spawnSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

export interface AudioResult {
  title: string;
  transcript: string;
  markdown: string;
  duration?: string;
  sourcePath: string;
}

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma']);

export function isAudioFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function processAudio(filePath: string): Promise<AudioResult> {
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath, ext);

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported audio format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
  }

  // Try Deepgram API first
  const deepgramKey = process.env['DEEPGRAM_API_KEY'];
  if (deepgramKey) {
    return await transcribeWithDeepgram(filePath, title, deepgramKey);
  }

  // Try local Whisper CLI
  if (isWhisperAvailable()) {
    return await transcribeWithWhisper(filePath, title);
  }

  // Fallback: reference without transcription
  return {
    title,
    transcript: '',
    markdown: buildMarkdown(title, filePath, '[Audio file — install Whisper or set DEEPGRAM_API_KEY for transcription]'),
    sourcePath: filePath,
  };
}

async function transcribeWithWhisper(filePath: string, title: string): Promise<AudioResult> {
  const tmpOutput = join(tmpdir(), `wikimem-whisper-${Date.now()}`);

  const result = spawnSync('whisper', [
    filePath,
    '--model', 'base',
    '--output_format', 'txt',
    '--output_dir', tmpdir(),
    '--fp16', 'False',
  ], { encoding: 'utf-8', timeout: 300000 });

  if (result.status !== 0) {
    throw new Error(`Whisper failed: ${result.stderr}`);
  }

  // Find the output .txt file
  const txtPath = join(tmpdir(), `${basename(filePath, extname(filePath))}.txt`);
  const transcript = existsSync(txtPath) ? readFileSync(txtPath, 'utf-8').trim() : '';

  // Clean up
  if (existsSync(txtPath)) unlinkSync(txtPath);

  // Get duration via ffprobe if available
  const duration = getDuration(filePath);

  return {
    title,
    transcript,
    markdown: buildMarkdown(title, filePath, transcript, duration),
    duration,
    sourcePath: filePath,
  };
}

async function transcribeWithDeepgram(filePath: string, title: string, apiKey: string): Promise<AudioResult> {
  const audioData = readFileSync(filePath);

  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&paragraphs=true', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': getContentType(extname(filePath)),
    },
    body: audioData,
  });

  if (!response.ok) {
    throw new Error(`Deepgram API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    results: {
      channels: Array<{
        alternatives: Array<{ transcript: string; paragraphs?: { paragraphs: Array<{ sentences: Array<{ text: string }> }> } }>;
      }>;
    };
    metadata: { duration: number };
  };

  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  const durationSec = data.metadata?.duration;
  const duration = durationSec ? formatDuration(durationSec) : undefined;

  return {
    title,
    transcript,
    markdown: buildMarkdown(title, filePath, transcript, duration),
    duration,
    sourcePath: filePath,
  };
}

function buildMarkdown(title: string, filePath: string, transcript: string, duration?: string): string {
  return `# ${title}

> **Source:** [${basename(filePath)}](${filePath})
> **Type:** Audio${duration ? `\n> **Duration:** ${duration}` : ''}
> **Processed:** ${new Date().toISOString().split('T')[0]}

## Transcript

${transcript || '_No transcript available._'}
`;
}

function isWhisperAvailable(): boolean {
  try {
    const result = spawnSync('whisper', ['--help'], { encoding: 'utf-8', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getDuration(filePath: string): string | undefined {
  try {
    const result = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf-8', timeout: 10000 });
    const seconds = parseFloat(result.stdout.trim());
    return isNaN(seconds) ? undefined : formatDuration(seconds);
  } catch {
    return undefined;
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getContentType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.ogg': return 'audio/ogg';
    case '.flac': return 'audio/flac';
    default: return 'audio/mpeg';
  }
}
