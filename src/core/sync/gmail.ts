/**
 * Gmail sync module — fetches recent threads and writes them as markdown
 * into the wiki vault's raw/{date}/ directory.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncFilters, SyncPreviewResult, PreviewItem } from './sync-filters.js';
import { estimateTokens, formatCostEstimate, isAfterSince } from './sync-filters.js';

export interface GmailSyncOptions {
  token: string;
  vaultRoot: string;
  maxThreads?: number;
  query?: string;
  labelIds?: string[];
  /** Sync filter overrides */
  filters?: SyncFilters;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface GmailHeader { name: string; value: string }

interface GmailMessagePart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload: {
    headers: GmailHeader[];
    mimeType: string;
    body: { data?: string; size: number };
    parts?: GmailMessagePart[];
  };
  internalDate: string;
}

interface GmailThread {
  id: string;
  historyId: string;
  messages?: GmailMessage[];
}

interface ThreadListResponse {
  threads?: Array<{ id: string; historyId: string; snippet: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

interface FetchOk<T> { ok: true; data: T }
interface FetchErr { ok: false; status: number; message: string }
type FetchResult<T> = FetchOk<T> | FetchErr;

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function getHeader(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decode64(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function extractPlainText(part: GmailMessagePart): string {
  if (part.mimeType === 'text/plain' && part.body.data) return decode64(part.body.data);
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractPlainText(sub);
      if (text) return text;
    }
  }
  return '';
}

function extractBody(msg: GmailMessage): string {
  const { payload } = msg;
  if (payload.body.data) return decode64(payload.body.data);
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body.data) return decode64(plain.body.data);
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body.data) return decode64(html.body.data);
  }
  return '(no body content)';
}

function sanitizeFilename(raw: string): string {
  return (
    raw.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 120) ||
    'untitled'
  );
}

function formatDate(internalDate: string): string {
  const ms = parseInt(internalDate, 10);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function errorHint(status: number, message: string): string {
  if (status === 401) return 'Token expired — re-authenticate with Google OAuth';
  if (status === 429) return 'Rate limited — try again later';
  return `HTTP ${status}: ${message}`;
}

async function gmailFetch<T>(endpoint: string, token: string): Promise<FetchResult<T>> {
  const res = await fetch(`${API}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, message: body };
  }
  return { ok: true, data: (await res.json()) as T };
}

async function listThreads(
  token: string,
  maxResults: number,
  query?: string,
  labelIds?: string[],
): Promise<{ threads: Array<{ id: string }>; errors: string[] }> {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (query) params.set('q', query);
  if (labelIds?.length) {
    for (const lid of labelIds) params.append('labelIds', lid);
  }
  const result = await gmailFetch<ThreadListResponse>(`/threads?${params.toString()}`, token);
  if (result.ok === false) {
    return { threads: [], errors: [`listThreads: ${errorHint(result.status, result.message)}`] };
  }
  return { threads: result.data.threads ?? [], errors: [] };
}

async function getThread(
  token: string,
  threadId: string,
): Promise<{ thread: GmailThread | null; error: string | null }> {
  const result = await gmailFetch<GmailThread>(`/threads/${threadId}?format=full`, token);
  if (result.ok === false) {
    return { thread: null, error: `getThread(${threadId}): ${errorHint(result.status, result.message)}` };
  }
  return { thread: result.data, error: null };
}

function threadToMarkdown(thread: GmailThread): { filename: string; content: string } {
  const messages = thread.messages ?? [];
  const firstMsg = messages[0];
  const headers = firstMsg?.payload.headers ?? [];
  const subject = getHeader(headers, 'Subject') || '(no subject)';
  const from = getHeader(headers, 'From');
  const date = firstMsg ? formatDate(firstMsg.internalDate) : new Date().toISOString();

  const esc = (s: string) => s.replace(/'/g, "''");
  const frontmatter = [
    '---',
    `addedBy: 'connector'`,
    `source: 'gmail'`,
    `subject: '${esc(subject)}'`,
    `from: '${esc(from)}'`,
    `date: '${date}'`,
    `threadId: '${thread.id}'`,
    `messageCount: ${messages.length}`,
    '---',
  ].join('\n');

  const body = messages
    .map((msg) => {
      const mFrom = getHeader(msg.payload.headers, 'From');
      const mDate = formatDate(msg.internalDate);
      return `## From: ${mFrom}\n_${mDate}_\n\n${extractBody(msg).trim()}`;
    })
    .join('\n\n---\n\n');

  return {
    filename: `gmail-${sanitizeFilename(subject)}.md`,
    content: `${frontmatter}\n\n# ${subject}\n\n${body}\n`,
  };
}

/** Preview what Gmail threads would be synced with the given filters */
export async function previewGmail(options: GmailSyncOptions): Promise<SyncPreviewResult> {
  const errors: string[] = [];
  const filters = options.filters ?? {};
  const maxThreads = filters.maxItems ?? options.maxThreads ?? 50;
  const query = filters.query ?? options.query;
  const labelIds = filters.labels ?? options.labelIds;

  const { threads, errors: listErrors } = await listThreads(
    options.token, maxThreads, query, labelIds,
  );
  errors.push(...listErrors);

  const items: PreviewItem[] = [];
  let totalChars = 0;

  for (const stub of threads.slice(0, Math.min(25, maxThreads))) {
    const { thread, error } = await getThread(options.token, stub.id);
    if (error) { errors.push(error); continue; }
    if (!thread || !thread.messages?.length) continue;

    const firstMsg = thread.messages[0]!;
    const headers = firstMsg.payload.headers;
    const subject = getHeader(headers, 'Subject') || '(no subject)';
    const from = getHeader(headers, 'From');
    const date = formatDate(firstMsg.internalDate);

    if (!isAfterSince(date, filters.since)) continue;

    const bodyLen = thread.messages.reduce((sum, msg) => sum + extractBody(msg).length, 0);
    totalChars += bodyLen;

    items.push({
      id: thread.id,
      title: subject,
      date,
      type: 'thread',
      sizeEstimate: bodyLen,
      meta: { from, messageCount: thread.messages.length },
    });
  }

  // If we only fetched 25 but there are more, extrapolate
  const estimatedTotal = threads.length;
  const avgChars = items.length > 0 ? totalChars / items.length : 500;
  const fullEstimateChars = Math.round(avgChars * estimatedTotal);
  const tokens = estimateTokens(fullEstimateChars, estimatedTotal);

  return {
    provider: 'gmail',
    totalItems: estimatedTotal,
    items,
    estimatedTokens: tokens,
    costEstimate: formatCostEstimate(tokens),
    errors,
  };
}

export async function syncGmail(options: GmailSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;
  const filters = options.filters ?? {};

  // Preview mode — return without writing
  if (filters.preview) {
    const preview = await previewGmail(options);
    return { provider: 'gmail', filesWritten: 0, errors: preview.errors, duration: Date.now() - start };
  }

  const maxThreads = filters.maxItems ?? options.maxThreads ?? 50;
  const query = filters.query ?? options.query;
  const labelIds = filters.labels ?? options.labelIds;
  const outDir = join(options.vaultRoot, 'raw', todayStr());

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const { threads, errors: listErrors } = await listThreads(
    options.token, maxThreads, query, labelIds,
  );
  errors.push(...listErrors);

  if (threads.length === 0 && listErrors.length > 0) {
    return { provider: 'gmail', filesWritten: 0, errors, duration: Date.now() - start };
  }

  for (const stub of threads) {
    const { thread, error } = await getThread(options.token, stub.id);
    if (error) { errors.push(error); continue; }
    if (!thread) continue;

    // Apply since filter
    if (filters.since && thread.messages?.length) {
      const threadDate = formatDate(thread.messages[0]!.internalDate);
      if (!isAfterSince(threadDate, filters.since)) continue;
    }

    const { filename, content } = threadToMarkdown(thread);
    try {
      writeFileSync(join(outDir, filename), content, 'utf-8');
      filesWritten++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Write failed (${filename}): ${msg}`);
    }
  }

  return { provider: 'gmail', filesWritten, errors, duration: Date.now() - start };
}
