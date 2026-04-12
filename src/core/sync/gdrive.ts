/**
 * Google Drive sync module — fetches recent files and exports Google Workspace
 * documents as markdown wiki pages under wiki/sources/.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GDriveSyncOptions {
  token: string;
  vaultRoot: string;
  folderId?: string;
  maxFiles?: number;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

interface DriveFileListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

interface FetchOk<T> { ok: true; data: T }
interface FetchErr { ok: false; status: number; message: string }
type FetchResult<T> = FetchOk<T> | FetchErr;

const API = 'https://www.googleapis.com/drive/v3';

/** Google Workspace MIME types we can export as text */
const EXPORT_MAP: Record<string, { mimeType: string; label: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', label: 'Google Doc' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', label: 'Google Sheet' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', label: 'Google Slides' },
};

/** MIME types we can download directly as text */
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'text/x-python',
  'text/javascript',
  'application/x-yaml',
]);

function sanitizeFilename(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'untitled'
  );
}

function errorHint(status: number, message: string): string {
  if (status === 401) return 'Token expired — re-authenticate with Google OAuth';
  if (status === 403) return 'Insufficient permissions — ensure drive.readonly scope';
  if (status === 429) return 'Rate limited — try again later';
  return `HTTP ${status}: ${message}`;
}

function recentTimestamp(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

async function driveFetch<T>(url: string, token: string): Promise<FetchResult<T>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, message: body };
  }
  return { ok: true, data: (await res.json()) as T };
}

async function driveFetchText(url: string, token: string): Promise<FetchResult<string>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, message: body };
  }
  return { ok: true, data: await res.text() };
}

async function listFiles(
  token: string,
  maxFiles: number,
  folderId?: string,
): Promise<{ files: DriveFile[]; errors: string[] }> {
  const errors: string[] = [];
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;
  const since = recentTimestamp();

  do {
    const params = new URLSearchParams({
      orderBy: 'modifiedTime desc',
      pageSize: String(Math.min(50, maxFiles - allFiles.length)),
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
    });

    const queryParts = [`modifiedTime > '${since}'`, 'trashed = false'];
    if (folderId) {
      queryParts.push(`'${folderId}' in parents`);
    }
    params.set('q', queryParts.join(' and '));

    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const result = await driveFetch<DriveFileListResponse>(
      `${API}/files?${params.toString()}`,
      token,
    );

    if (!result.ok) {
      errors.push(`listFiles: ${errorHint(result.status, result.message)}`);
      break;
    }

    allFiles.push(...result.data.files);
    pageToken = result.data.nextPageToken;
  } while (pageToken && allFiles.length < maxFiles);

  return { files: allFiles.slice(0, maxFiles), errors };
}

async function exportFile(
  token: string,
  fileId: string,
  exportMimeType: string,
): Promise<{ content: string | null; error: string | null }> {
  const result = await driveFetchText(
    `${API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
    token,
  );
  if (!result.ok) {
    return { content: null, error: `export(${fileId}): ${errorHint(result.status, result.message)}` };
  }
  return { content: result.data, error: null };
}

async function downloadFile(
  token: string,
  fileId: string,
): Promise<{ content: string | null; error: string | null }> {
  const result = await driveFetchText(
    `${API}/files/${fileId}?alt=media`,
    token,
  );
  if (!result.ok) {
    return { content: null, error: `download(${fileId}): ${errorHint(result.status, result.message)}` };
  }
  return { content: result.data, error: null };
}

function fileToMarkdown(
  file: DriveFile,
  body: string,
  sourceLabel: string,
): { filename: string; content: string } {
  const esc = (s: string) => s.replace(/'/g, "''");
  const frontmatter = [
    '---',
    `type: source`,
    `source-type: gdrive`,
    `title: '${esc(file.name)}'`,
    `gdrive-id: '${file.id}'`,
    `mime-type: '${file.mimeType}'`,
    `modified: '${file.modifiedTime}'`,
    `created: '${new Date().toISOString()}'`,
    file.webViewLink ? `link: '${file.webViewLink}'` : null,
    `tags: [gdrive, ${sourceLabel.toLowerCase().replace(/\s+/g, '-')}]`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  const links = file.webViewLink
    ? `\n## Links\n\n- [Open in Google Drive](${file.webViewLink})\n`
    : '';

  return {
    filename: `gdrive-${sanitizeFilename(file.name)}.md`,
    content: `${frontmatter}\n\n# ${file.name}\n\n> Source: ${sourceLabel} via Google Drive sync\n\n${body.trim()}\n${links}`,
  };
}

export async function syncGDrive(options: GDriveSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;
  const maxFiles = options.maxFiles ?? 50;
  const outDir = join(options.vaultRoot, 'wiki', 'sources');

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const { files, errors: listErrors } = await listFiles(
    options.token,
    maxFiles,
    options.folderId,
  );
  errors.push(...listErrors);

  if (files.length === 0 && listErrors.length > 0) {
    return { provider: 'gdrive', filesWritten: 0, errors, duration: Date.now() - start };
  }

  for (const file of files) {
    const exportInfo = EXPORT_MAP[file.mimeType];

    if (exportInfo) {
      // Google Workspace file — export via /export endpoint
      const { content, error } = await exportFile(options.token, file.id, exportInfo.mimeType);
      if (error) { errors.push(error); continue; }
      if (!content) continue;

      const { filename, content: md } = fileToMarkdown(file, content, exportInfo.label);
      try {
        writeFileSync(join(outDir, filename), md, 'utf-8');
        filesWritten++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Write failed (${filename}): ${msg}`);
      }
    } else if (TEXT_MIME_TYPES.has(file.mimeType)) {
      // Plain text file — download directly
      const { content, error } = await downloadFile(options.token, file.id);
      if (error) { errors.push(error); continue; }
      if (!content) continue;

      const label = file.mimeType.split('/').pop() ?? 'text';
      const { filename, content: md } = fileToMarkdown(file, content, label);
      try {
        writeFileSync(join(outDir, filename), md, 'utf-8');
        filesWritten++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Write failed (${filename}): ${msg}`);
      }
    } else {
      // Binary file (PDF, image, etc.) — note existence but skip content
      const body = `_Binary file (${file.mimeType}) — content not exported. Open in Google Drive to view._`;
      const { filename, content: md } = fileToMarkdown(file, body, 'binary');
      try {
        writeFileSync(join(outDir, filename), md, 'utf-8');
        filesWritten++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Write failed (${filename}): ${msg}`);
      }
    }
  }

  return { provider: 'gdrive', filesWritten, errors, duration: Date.now() - start };
}
