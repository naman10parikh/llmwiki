import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { VaultConfig } from './vault.js';

export interface GitConfig {
  enabled: boolean;
  autoCommit: boolean;
  remote?: string;
  defaultBranch: string;
}

export interface GitCommitResult {
  hash: string;
  branch: string;
  message: string;
  filesChanged: number;
}

export interface GitLogEntry {
  hash: string;
  hashShort: string;
  author: string;
  date: string;
  message: string;
  filesChanged: string[];
  isWiki: boolean;
}

export interface GitBranchInfo {
  current: string;
  all: string[];
  isDetached: boolean;
}

export interface GitDiffEntry {
  file: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export const WIKI_COMMIT_PREFIX = 'wiki:';

function getGit(vaultRoot: string): SimpleGit {
  return simpleGit(vaultRoot);
}

export function isWikiCommit(message: string): boolean {
  return message.startsWith(WIKI_COMMIT_PREFIX);
}

export async function isGitRepo(vaultRoot: string): Promise<boolean> {
  try {
    const git = getGit(vaultRoot);
    await git.status();
    return true;
  } catch {
    return false;
  }
}

export async function initGitRepo(config: VaultConfig): Promise<{ initialized: boolean; message: string }> {
  const git = getGit(config.root);

  if (await isGitRepo(config.root)) {
    return { initialized: false, message: 'Already a git repository' };
  }

  await git.init();

  const gitignorePath = join(config.root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(gitignorePath, [
      'node_modules/',
      '.env',
      '.wikimem/history/snapshots/',
      '.DS_Store',
      '*.log',
    ].join('\n') + '\n', 'utf-8');
  }

  await git.add('.');
  await git.commit('wiki: feat: initialize wikimem vault');

  return { initialized: true, message: 'Initialized git repository with initial commit' };
}

export async function autoCommit(
  vaultRoot: string,
  automation: 'ingest' | 'scrape' | 'improve' | 'manual' | 'restore',
  summary: string,
  details?: string,
): Promise<GitCommitResult | null> {
  if (!(await isGitRepo(vaultRoot))) return null;

  const git = getGit(vaultRoot);
  const status = await git.status();

  if (status.files.length === 0) return null;

  await git.add('.');

  const prefix = automation === 'manual' ? 'feat(manual)' :
    automation === 'restore' ? 'revert(restore)' :
    automation === 'improve' ? 'refactor(improve)' :
    `feat(${automation})`;

  const message = `wiki: ${prefix}: ${summary}`;
  const body = details ? `\n\n${details}` : '';
  const fullMessage = message + body;

  const result = await git.commit(fullMessage);
  const branch = (await git.branch()).current;

  return {
    hash: result.commit || 'unknown',
    branch,
    message,
    filesChanged: status.files.length,
  };
}

export async function getGitLog(
  vaultRoot: string,
  limit: number = 50,
  options?: { wikiOnly?: boolean; search?: string },
): Promise<GitLogEntry[]> {
  if (!(await isGitRepo(vaultRoot))) return [];

  const git = getGit(vaultRoot);
  const fetchLimit = options?.wikiOnly ? limit * 3 : limit;
  const logOpts: Record<string, unknown> = { maxCount: fetchLimit, '--stat': null };

  if (options?.search) {
    logOpts['--grep'] = options.search;
  }

  const log = await git.log(logOpts);

  let entries = log.all.map((entry) => ({
    hash: entry.hash,
    hashShort: entry.hash.substring(0, 7),
    author: entry.author_name,
    date: entry.date,
    message: entry.message,
    filesChanged: entry.diff?.files?.map(f => f.file) ?? [],
    isWiki: isWikiCommit(entry.message),
  }));

  if (options?.wikiOnly) {
    entries = entries.filter((e) => e.isWiki);
  }

  return entries.slice(0, limit);
}

export async function getGitDiff(
  vaultRoot: string,
  commitHash: string,
): Promise<{ diff: string; stats: GitDiffEntry[] }> {
  if (!(await isGitRepo(vaultRoot))) return { diff: '', stats: [] };

  const git = getGit(vaultRoot);

  const diff = await git.diff([`${commitHash}~1`, commitHash]);
  const diffStat = await git.diffSummary([`${commitHash}~1`, commitHash]);

  return {
    diff,
    stats: diffStat.files.map((f) => ({
      file: f.file,
      insertions: 'insertions' in f ? f.insertions : 0,
      deletions: 'deletions' in f ? f.deletions : 0,
      binary: f.binary,
    })),
  };
}

export async function getBranches(vaultRoot: string): Promise<GitBranchInfo> {
  if (!(await isGitRepo(vaultRoot))) {
    return { current: 'main', all: [], isDetached: false };
  }

  const git = getGit(vaultRoot);
  const branches = await git.branch();

  return {
    current: branches.current,
    all: branches.all,
    isDetached: branches.detached,
  };
}

export async function createBranch(
  vaultRoot: string,
  branchName: string,
  fromHash?: string,
): Promise<{ created: boolean; message: string }> {
  if (!(await isGitRepo(vaultRoot))) {
    return { created: false, message: 'Not a git repository' };
  }

  const git = getGit(vaultRoot);

  try {
    if (fromHash) {
      await git.raw(['branch', branchName, fromHash]);
      return { created: true, message: `Created branch ${branchName} from ${fromHash.substring(0, 7)}` };
    }
    await git.checkoutLocalBranch(branchName);
    return { created: true, message: `Created and switched to branch: ${branchName}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { created: false, message: `Failed to create branch: ${msg}` };
  }
}

export async function switchBranch(
  vaultRoot: string,
  branchName: string,
): Promise<{ switched: boolean; message: string }> {
  if (!(await isGitRepo(vaultRoot))) {
    return { switched: false, message: 'Not a git repository' };
  }

  const git = getGit(vaultRoot);

  try {
    await git.checkout(branchName);
    return { switched: true, message: `Switched to branch: ${branchName}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { switched: false, message: `Failed to switch branch: ${msg}` };
  }
}

export async function getGitStatus(vaultRoot: string): Promise<StatusResult | null> {
  if (!(await isGitRepo(vaultRoot))) return null;

  const git = getGit(vaultRoot);
  return git.status();
}

export async function createTag(
  vaultRoot: string,
  tagName: string,
  message?: string,
  wikiNamespace: boolean = true,
): Promise<{ created: boolean; message: string; tag: string }> {
  if (!(await isGitRepo(vaultRoot))) {
    return { created: false, message: 'Not a git repository', tag: '' };
  }

  const git = getGit(vaultRoot);
  const prefixed = wikiNamespace && !tagName.startsWith('wiki/') ? `wiki/${tagName}` : tagName;

  try {
    if (message) {
      await git.tag(['-a', prefixed, '-m', message]);
    } else {
      await git.tag([prefixed]);
    }
    return { created: true, message: `Created tag: ${prefixed}`, tag: prefixed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { created: false, message: `Failed to create tag: ${msg}`, tag: '' };
  }
}

export async function restoreToCommit(
  vaultRoot: string,
  commitHash: string,
): Promise<{ restored: boolean; branch: string; message: string }> {
  if (!(await isGitRepo(vaultRoot))) {
    return { restored: false, branch: '', message: 'Not a git repository' };
  }

  const git = getGit(vaultRoot);
  const branchName = `wiki/restore-${commitHash.substring(0, 7)}`;

  try {
    await git.checkout(['-b', branchName, commitHash]);
    return {
      restored: true,
      branch: branchName,
      message: `Restored to commit ${commitHash.substring(0, 7)} on new branch: ${branchName}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { restored: false, branch: '', message: `Failed to restore: ${msg}` };
  }
}

export async function getFileAtCommit(
  vaultRoot: string,
  commitHash: string,
  filePath: string,
): Promise<string | null> {
  if (!(await isGitRepo(vaultRoot))) return null;

  const git = getGit(vaultRoot);
  try {
    return await git.show([`${commitHash}:${filePath}`]);
  } catch {
    return null;
  }
}

export async function getTreeAtCommit(
  vaultRoot: string,
  commitHash: string,
  path: string = '',
): Promise<string[]> {
  if (!(await isGitRepo(vaultRoot))) return [];

  const git = getGit(vaultRoot);
  try {
    const filterPath = path || '.';
    const result = await git.raw(['ls-tree', '-r', '--name-only', commitHash, '--', filterPath]);
    return result.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export interface GraphNodeSnapshot {
  id: string;
  title: string;
  category: string;
  linksIn: number;
}

export interface GraphSnapshot {
  nodes: GraphNodeSnapshot[];
  links: Array<{ source: string; target: string }>;
}

export async function getGraphAtCommit(
  vaultRoot: string,
  commitHash: string,
): Promise<GraphSnapshot> {
  if (!(await isGitRepo(vaultRoot))) return { nodes: [], links: [] };

  const git = getGit(vaultRoot);
  try {
    const tree = await git.raw(['ls-tree', '-r', '--name-only', commitHash, '--', 'wiki']);
    const wikiFiles = tree.split('\n').filter(f => f.endsWith('.md'));

    const nodes: GraphNodeSnapshot[] = [];
    const links: Array<{ source: string; target: string }> = [];
    const titleToId = new Map<string, string>();
    const pageData: Array<{ id: string; title: string; category: string; wikilinks: string[] }> = [];

    for (const filePath of wikiFiles) {
      try {
        const content = await git.show([`${commitHash}:${filePath}`]);
        const parts = filePath.split('/');
        const filename = parts[parts.length - 1] ?? '';
        const id = filename.replace('.md', '');
        const category = parts.length > 2 ? (parts[1] ?? 'page') : 'page';

        let title = id;
        const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (titleMatch?.[1]) title = titleMatch[1];

        const wikilinks: string[] = [];
        const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        let match;
        while ((match = linkRegex.exec(content)) !== null) {
          if (match[1]) wikilinks.push(match[1]);
        }

        pageData.push({ id, title, category, wikilinks });
        titleToId.set(title, id);
        titleToId.set(title.toLowerCase(), id);
        titleToId.set(id, id);
      } catch {
        // file may not exist at this commit
      }
    }

    const inDegree = new Map<string, number>();
    for (const page of pageData) {
      nodes.push({ id: page.id, title: page.title, category: page.category, linksIn: 0 });
      for (const link of page.wikilinks) {
        const targetId = titleToId.get(link) ?? titleToId.get(link.toLowerCase())
          ?? titleToId.get(link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        if (targetId && targetId !== page.id) {
          links.push({ source: page.id, target: targetId });
          inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
        }
      }
    }

    for (const node of nodes) {
      node.linksIn = inDegree.get(node.id) ?? 0;
    }

    return { nodes, links };
  } catch {
    return { nodes: [], links: [] };
  }
}
