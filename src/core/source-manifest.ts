import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

/** Path to the per-vault source manifest, relative to vault root. */
export const MANIFEST_FILENAME = '.wikimem-manifest.json';

export interface ManifestEntry {
  /** Epoch ms of the last observed mtime for the source file. */
  mtime: number;
  /** Hex-encoded SHA-256 of the file contents at `ingestedAt`. */
  sha256: string;
  /** ISO-8601 timestamp of the last successful ingest. */
  ingestedAt: string;
}

export interface SourceManifest {
  /** Schema version — bump when the shape changes. */
  version: 1;
  /** Absolute source path → ingest record. */
  entries: Record<string, ManifestEntry>;
}

export interface ManifestDiff {
  newFiles: string[];
  changedFiles: string[];
  unchangedFiles: string[];
}

const EMPTY_MANIFEST: SourceManifest = { version: 1, entries: {} };

export function getManifestPath(vaultRoot: string): string {
  return join(vaultRoot, MANIFEST_FILENAME);
}

export function loadManifest(vaultRoot: string): SourceManifest {
  const path = getManifestPath(vaultRoot);
  if (!existsSync(path)) return { ...EMPTY_MANIFEST, entries: {} };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SourceManifest>;
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { ...EMPTY_MANIFEST, entries: {} };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { ...EMPTY_MANIFEST, entries: {} };
  }
}

export function saveManifest(vaultRoot: string, manifest: SourceManifest): void {
  const path = getManifestPath(vaultRoot);
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8');
}

export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

export function getFileMtime(filePath: string): number {
  return statSync(filePath).mtimeMs;
}

/**
 * Classify each file as new / changed / unchanged vs. the manifest.
 * A file is "changed" when its mtime is later than the recorded mtime AND its
 * sha256 differs — mtime-only bumps without content change are treated as unchanged.
 */
export function diffManifest(files: string[], manifest: SourceManifest): ManifestDiff {
  const newFiles: string[] = [];
  const changedFiles: string[] = [];
  const unchangedFiles: string[] = [];

  for (const file of files) {
    const abs = resolve(file);
    const entry = manifest.entries[abs];
    if (!entry) {
      newFiles.push(abs);
      continue;
    }
    let currentMtime: number;
    try {
      currentMtime = getFileMtime(abs);
    } catch {
      unchangedFiles.push(abs);
      continue;
    }
    if (currentMtime <= entry.mtime) {
      unchangedFiles.push(abs);
      continue;
    }
    let currentHash: string;
    try {
      currentHash = hashFile(abs);
    } catch {
      unchangedFiles.push(abs);
      continue;
    }
    if (currentHash === entry.sha256) {
      unchangedFiles.push(abs);
    } else {
      changedFiles.push(abs);
    }
  }

  return { newFiles, changedFiles, unchangedFiles };
}

export function recordIngest(manifest: SourceManifest, filePath: string): ManifestEntry {
  const abs = resolve(filePath);
  const entry: ManifestEntry = {
    mtime: getFileMtime(abs),
    sha256: hashFile(abs),
    ingestedAt: new Date().toISOString(),
  };
  manifest.entries[abs] = entry;
  return entry;
}
