import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANIFEST_FILENAME,
  getManifestPath,
  loadManifest,
  saveManifest,
  hashFile,
  getFileMtime,
  diffManifest,
} from '../src/core/source-manifest.js';

const TMP_ROOT = join(process.cwd(), '.test-vault-source-manifest');

function setup(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
}

function teardown(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

describe('source-manifest', () => {
  beforeEach(setup);
  afterAll(teardown);

  it('returns empty manifest when file does not exist', () => {
    const manifest = loadManifest(TMP_ROOT);
    expect(manifest.entries).toEqual({});
    expect(manifest.version).toBeDefined();
  });

  it('persists and reloads entries', () => {
    const original = {
      version: 1,
      entries: {
        '/tmp/test.md': { mtime: 1000, sha256: 'abc', ingestedAt: '2026-04-17' },
      },
    };
    saveManifest(TMP_ROOT, original);
    expect(existsSync(getManifestPath(TMP_ROOT))).toBe(true);

    const loaded = loadManifest(TMP_ROOT);
    expect(loaded.entries['/tmp/test.md']).toEqual(original.entries['/tmp/test.md']);
  });

  it('hashes file content deterministically', () => {
    const path = join(TMP_ROOT, 'a.txt');
    writeFileSync(path, 'hello', 'utf-8');

    const hash1 = hashFile(path);
    const hash2 = hashFile(path);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(path, 'hello world', 'utf-8');
    const hash3 = hashFile(path);
    expect(hash3).not.toBe(hash1);
  });

  it('mtime returns a timestamp in ms', () => {
    const path = join(TMP_ROOT, 'b.txt');
    writeFileSync(path, 'x', 'utf-8');
    const m = getFileMtime(path);
    expect(m).toBeGreaterThan(0);
    // Allow 1s tolerance for filesystem mtime rounding on some macOS/APFS stacks
    expect(m).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('diff reports NEW/CHANGED/UNCHANGED buckets', () => {
    const a = join(TMP_ROOT, 'a.txt');
    const b = join(TMP_ROOT, 'b.txt');
    const c = join(TMP_ROOT, 'c.txt');
    writeFileSync(a, 'aa', 'utf-8');
    writeFileSync(b, 'bb', 'utf-8');
    writeFileSync(c, 'cc', 'utf-8');

    const manifest = {
      version: 1,
      entries: {
        [a]: { mtime: getFileMtime(a), sha256: hashFile(a), ingestedAt: '2026-04-17' },
        [b]: { mtime: getFileMtime(b) - 1000, sha256: 'stale', ingestedAt: '2026-04-17' },
      },
    };

    const diff = diffManifest([a, b, c], manifest);
    expect(diff.unchangedFiles).toContain(a);
    expect(diff.changedFiles).toContain(b);
    expect(diff.newFiles).toContain(c);
  });
});
