import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  automation: 'ingest' | 'scrape' | 'improve' | 'manual' | 'restore' | 'observe' | 'resolve',
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
    // Resolve relative path from git root to vault
    const gitRootRaw = await git.raw(['rev-parse', '--show-toplevel']);
    const gitRoot = gitRootRaw.trim();
    const { resolve, relative } = await import('node:path');
    const relPath = relative(resolve(gitRoot), resolve(vaultRoot));
    const filterPath = path ? (relPath ? `${relPath}/${path}` : path) : (relPath || '.');
    const result = await git.raw(['ls-tree', '-r', '--name-only', commitHash, '--', filterPath]);
    // Strip the vault prefix from returned paths so they're relative to vault
    return result.split('\n').filter(Boolean).map(f =>
      relPath && f.startsWith(relPath + '/') ? f.slice(relPath.length + 1) : f
    );
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

export interface ParsedDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  insertions: number;
  deletions: number;
  hunks: Array<{
    header: string;
    lines: Array<{ type: 'add' | 'del' | 'ctx'; content: string }>;
  }>;
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
  stats: { additions: number; deletions: number; filesChanged: number };
}

export interface PushResult {
  pushed: boolean;
  remote: string;
  branch: string;
  message: string;
}

export interface PRSubmission {
  branch: string;
  baseBranch: string;
  pushed: boolean;
  pushMessage: string;
  diff: {
    filesAdded: string[];
    filesModified: string[];
    filesDeleted: string[];
    totalAdditions: number;
    totalDeletions: number;
  };
}

export function parseDiffOutput(rawDiff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const headerMatch = section.match(/^a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const aPath = headerMatch[1]!;
    const bPath = headerMatch[2]!;

    let status: ParsedDiffFile['status'] = 'modified';
    if (section.includes('new file mode')) status = 'added';
    else if (section.includes('deleted file mode')) status = 'deleted';
    else if (section.includes('rename from')) status = 'renamed';

    const hunks: ParsedDiffFile['hunks'] = [];
    const hunkRegex = /^@@\s+[^@]+@@.*$/gm;
    let match;
    const hunkHeaders: Array<{ header: string; index: number }> = [];

    while ((match = hunkRegex.exec(section)) !== null) {
      hunkHeaders.push({ header: match[0], index: match.index + match[0].length });
    }

    let insertions = 0;
    let deletions = 0;

    for (let i = 0; i < hunkHeaders.length; i++) {
      const start = hunkHeaders[i]!.index;
      const end = i + 1 < hunkHeaders.length ? section.lastIndexOf('\n@@', hunkHeaders[i + 1]!.index) : section.length;
      const body = section.substring(start, end);
      const lines: ParsedDiffFile['hunks'][0]['lines'] = [];

      for (const line of body.split('\n')) {
        if (line.startsWith('+')) {
          lines.push({ type: 'add', content: line.substring(1) });
          insertions++;
        } else if (line.startsWith('-')) {
          lines.push({ type: 'del', content: line.substring(1) });
          deletions++;
        } else if (line.startsWith(' ') || line === '') {
          lines.push({ type: 'ctx', content: line.substring(1) || '' });
        }
      }

      hunks.push({ header: hunkHeaders[i]!.header, lines });
    }

    files.push({ path: status === 'deleted' ? aPath : bPath, status, insertions, deletions, hunks });
  }

  return files;
}

export async function getParsedDiff(
  vaultRoot: string,
  commitHash: string,
): Promise<ParsedDiff> {
  if (!(await isGitRepo(vaultRoot))) {
    return { files: [], stats: { additions: 0, deletions: 0, filesChanged: 0 } };
  }

  const git = getGit(vaultRoot);
  const raw = await git.diff([`${commitHash}~1`, commitHash]);
  const files = parseDiffOutput(raw);

  return {
    files,
    stats: {
      additions: files.reduce((s, f) => s + f.insertions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      filesChanged: files.length,
    },
  };
}

export async function pushBranch(
  vaultRoot: string,
  remote: string = 'origin',
): Promise<PushResult> {
  if (!(await isGitRepo(vaultRoot))) {
    return { pushed: false, remote: '', branch: '', message: 'Not a git repository' };
  }

  const git = getGit(vaultRoot);
  const branches = await git.branch();
  const branch = branches.current;

  try {
    const remotes = await git.getRemotes(true);
    const hasRemote = remotes.some(r => r.name === remote);
    if (!hasRemote) {
      return { pushed: false, remote, branch, message: `Remote "${remote}" not configured. Add a remote first.` };
    }

    await git.push(remote, branch, ['--set-upstream']);
    return { pushed: true, remote, branch, message: `Pushed ${branch} to ${remote}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { pushed: false, remote, branch, message: `Push failed: ${msg}` };
  }
}

export async function getDiffSummary(
  vaultRoot: string,
  baseBranch?: string,
): Promise<PRSubmission['diff']> {
  if (!(await isGitRepo(vaultRoot))) {
    return { filesAdded: [], filesModified: [], filesDeleted: [], totalAdditions: 0, totalDeletions: 0 };
  }

  const git = getGit(vaultRoot);
  const branches = await git.branch();
  const current = branches.current;
  const base = baseBranch || branches.all.find(b => b === 'main' || b === 'master') || 'main';

  if (current === base) {
    const status = await git.status();
    return {
      filesAdded: status.created,
      filesModified: status.modified,
      filesDeleted: status.deleted,
      totalAdditions: 0,
      totalDeletions: 0,
    };
  }

  try {
    const diff = await git.diffSummary([`${base}...${current}`]);
    const filesAdded: string[] = [];
    const filesModified: string[] = [];
    const filesDeleted: string[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const f of diff.files) {
      totalAdditions += 'insertions' in f ? f.insertions : 0;
      totalDeletions += 'deletions' in f ? f.deletions : 0;

      if (f.file.includes('=>')) {
        filesModified.push(f.file);
      } else if ('insertions' in f && f.insertions > 0 && ('deletions' in f ? f.deletions : 0) === 0) {
        filesAdded.push(f.file);
      } else if ('deletions' in f && f.deletions > 0 && ('insertions' in f ? f.insertions : 0) === 0) {
        filesDeleted.push(f.file);
      } else {
        filesModified.push(f.file);
      }
    }

    return { filesAdded, filesModified, filesDeleted, totalAdditions, totalDeletions };
  } catch {
    return { filesAdded: [], filesModified: [], filesDeleted: [], totalAdditions: 0, totalDeletions: 0 };
  }
}

export async function submitForReview(
  vaultRoot: string,
  description?: string,
): Promise<PRSubmission> {
  if (!(await isGitRepo(vaultRoot))) {
    throw new Error('Not a git repository');
  }

  const git = getGit(vaultRoot);
  const branches = await git.branch();
  let currentBranch = branches.current;
  const baseBranch = branches.all.find(b => b === 'main' || b === 'master') || 'main';

  if (currentBranch === baseBranch) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const sessionBranch = `wiki/session-${ts}`;
    await git.checkoutLocalBranch(sessionBranch);
    currentBranch = sessionBranch;
  }

  if (description) {
    const status = await git.status();
    if (status.files.length > 0) {
      await git.add('.');
      await git.commit(`wiki: feat(submit): ${description}`);
    }
  }

  const diff = await getDiffSummary(vaultRoot, baseBranch);

  let pushed = false;
  let pushMessage = 'No remote configured';
  try {
    const remotes = await git.getRemotes(true);
    if (remotes.length > 0) {
      const remote = remotes[0]!.name;
      await git.push(remote, currentBranch, ['--set-upstream']);
      pushed = true;
      pushMessage = `Pushed to ${remote}/${currentBranch}`;
    }
  } catch (err) {
    pushMessage = `Push failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return { branch: currentBranch, baseBranch, pushed, pushMessage, diff };
}

export async function migrateHistoryToGit(
  config: VaultConfig,
): Promise<{ migrated: number; skipped: number; message: string }> {
  const historyLogPath = join(config.root, '.wikimem', 'history', 'log.json');
  if (!existsSync(historyLogPath)) {
    return { migrated: 0, skipped: 0, message: 'No history log found' };
  }

  const git = getGit(config.root);
  if (!(await isGitRepo(config.root))) {
    return { migrated: 0, skipped: 0, message: 'Not a git repository' };
  }

  const logData = JSON.parse(readFileSync(historyLogPath, 'utf-8'));
  const entries: Array<{ id: string; timestamp: string; automation: string; summary: string; filesChanged: string[] }> = logData.entries ?? [];

  if (entries.length === 0) {
    return { migrated: 0, skipped: 0, message: 'No history entries to migrate' };
  }

  const snapshotsDir = join(config.root, '.wikimem', 'history', 'snapshots');
  let migrated = 0;
  let skipped = 0;

  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  for (const entry of sorted) {
    const snapDir = join(snapshotsDir, entry.id);
    if (!existsSync(snapDir)) {
      skipped++;
      continue;
    }

    const wikiSnapDir = join(snapDir, 'wiki');
    if (!existsSync(wikiSnapDir)) {
      skipped++;
      continue;
    }

    const { cpSync, rmSync } = await import('node:fs');
    const wikiDir = config.wikiDir;

    const wikiFiles = readdirSync(wikiDir).filter(f => f.endsWith('.md'));
    for (const f of wikiFiles) {
      rmSync(join(wikiDir, f), { force: true });
    }

    const snapFiles = readdirSync(wikiSnapDir).filter(f => f.endsWith('.md'));
    for (const f of snapFiles) {
      cpSync(join(wikiSnapDir, f), join(wikiDir, f));
    }

    await git.add('.');
    const commitDate = new Date(entry.timestamp).toISOString();
    const message = `wiki: ${entry.automation}: ${entry.summary}`;
    await git.raw([
      'commit', '--allow-empty',
      '-m', message,
      '--date', commitDate,
    ]);

    migrated++;
  }

  return {
    migrated,
    skipped,
    message: `Migrated ${migrated} snapshots as git commits (${skipped} skipped)`,
  };
}

export async function getGraphAtCommit(
  vaultRoot: string,
  commitHash: string,
): Promise<GraphSnapshot> {
  if (!(await isGitRepo(vaultRoot))) return { nodes: [], links: [] };

  const git = getGit(vaultRoot);
  try {
    // Resolve relative path from git root to vault (in case vault is a subdirectory)
    const gitRootRaw = await git.raw(['rev-parse', '--show-toplevel']);
    const gitRoot = gitRootRaw.trim();
    const { resolve, relative } = await import('node:path');
    const relPath = relative(resolve(gitRoot), resolve(vaultRoot));
    const wikiPath = relPath ? `${relPath}/wiki` : 'wiki';

    const tree = await git.raw(['ls-tree', '-r', '--name-only', commitHash, '--', wikiPath]);
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
        // Find category: the directory after "wiki/" in the path
        const wikiIdx = parts.indexOf('wiki');
        const category = wikiIdx >= 0 && parts.length > wikiIdx + 2
          ? (parts[wikiIdx + 1] ?? 'page')
          : 'page';

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
