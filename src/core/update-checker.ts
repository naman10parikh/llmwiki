import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = join(homedir(), '.wikimem');
const CACHE_FILE = join(CACHE_DIR, 'last-update-check');

function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json');
  return pkg.version as string;
}

function shouldCheck(): boolean {
  try {
    if (!existsSync(CACHE_FILE)) return true;
    const stat = statSync(CACHE_FILE);
    return Date.now() - stat.mtimeMs > CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function saveCheckTimestamp(): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(CACHE_FILE, new Date().toISOString());
  } catch {
    // Intentionally silent: non-critical cache write
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://registry.npmjs.org/wikimem/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [lMaj, lMin, lPatch] = parse(latest);
  const [cMaj, cMin, cPatch] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

export async function checkForUpdates(): Promise<void> {
  if (!shouldCheck()) return;

  const current = getCurrentVersion();
  const latest = await fetchLatestVersion();

  saveCheckTimestamp();

  if (latest && isNewer(latest, current)) {
    console.log(
      `\nUpdate available: ${current} → ${latest} — run: npm install -g wikimem@latest`
    );
  }
}
