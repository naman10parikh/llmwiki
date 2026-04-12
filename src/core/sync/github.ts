/**
 * GitHub Sync — fetches repos, issues, PRs, and READMEs into raw/ for wiki ingest.
 * Uses GitHub REST API v3 with OAuth access_token from .wikimem/tokens.json.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GitHubSyncOptions {
  token: string;
  vaultRoot: string;
  repos?: string[];
  maxRepos?: number;
  maxIssuesPerRepo?: number;
  maxPRsPerRepo?: number;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface GitHubRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  private: boolean;
  topics: string[];
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  user: { login: string } | null;
}

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
}

const API_BASE = 'https://api.github.com';
const MAX_TOTAL_CALLS = 200;

let callCount = 0;

async function ghFetch<T>(path: string, token: string): Promise<{ data: T | null; error: string | null }> {
  if (callCount >= MAX_TOTAL_CALLS) {
    return { data: null, error: `API call cap reached (${MAX_TOTAL_CALLS})` };
  }
  callCount++;

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'wikimem-sync',
      },
    });

    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining !== null && parseInt(remaining, 10) < 10) {
      const resetAt = res.headers.get('X-RateLimit-Reset');
      const resetTime = resetAt ? new Date(parseInt(resetAt, 10) * 1000).toISOString() : 'unknown';
      return { data: null, error: `Rate limit nearly exhausted (${remaining} left, resets ${resetTime})` };
    }

    if (!res.ok) {
      return { data: null, error: `GitHub API ${res.status}: ${res.statusText} for ${path}` };
    }

    const data = (await res.json()) as T;
    return { data, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, error: `Fetch failed for ${path}: ${msg}` };
  }
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function frontmatter(fields: Record<string, string | number | boolean | string[]>): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fields)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.map((v) => `"${v}"`).join(', ')}]`);
    } else if (typeof val === 'string') {
      lines.push(`${key}: "${val.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${String(val)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100);
}

function writeMarkdown(dir: string, filename: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
}

function buildRepoPage(repo: GitHubRepo): string {
  const fm = frontmatter({
    title: repo.full_name, addedBy: 'connector', source: 'github', type: 'repository',
    url: repo.html_url, language: repo.language ?? 'unknown',
    stars: repo.stargazers_count, forks: repo.forks_count, syncedAt: new Date().toISOString(),
  });
  const topics = repo.topics.length > 0 ? `\n**Topics:** ${repo.topics.join(', ')}` : '';
  return `${fm}\n\n# ${repo.full_name}\n\n${repo.description ?? '_No description._'}\n
| Stat | Value |
|------|-------|
| Language | ${repo.language ?? 'N/A'} |
| Stars | ${repo.stargazers_count} |
| Forks | ${repo.forks_count} |
| Open Issues | ${repo.open_issues_count} |
| Updated | ${repo.updated_at} |
| Private | ${repo.private ? 'Yes' : 'No'} |
${topics}\n\n[View on GitHub](${repo.html_url})\n`;
}

function buildIssuePage(repo: string, issue: GitHubIssue): string {
  const fm = frontmatter({
    title: `#${issue.number} ${issue.title}`, addedBy: 'connector', source: 'github',
    type: 'issue', repo, url: issue.html_url, state: issue.state,
    author: issue.user?.login ?? 'unknown', labels: issue.labels.map((l) => l.name),
    createdAt: issue.created_at, syncedAt: new Date().toISOString(),
  });
  const body = issue.body ? issue.body.slice(0, 5000) : '_No description._';
  return `${fm}\n\n# ${issue.title}\n\n**Issue #${issue.number}** in \`${repo}\` | ${issue.state} | by ${issue.user?.login ?? 'unknown'}\n\n${body}\n`;
}

function buildPRPage(repo: string, pr: GitHubPR): string {
  const fm = frontmatter({
    title: `PR #${pr.number} ${pr.title}`, addedBy: 'connector', source: 'github',
    type: 'pull-request', repo, url: pr.html_url, state: pr.state,
    author: pr.user?.login ?? 'unknown', branch: `${pr.head.ref} -> ${pr.base.ref}`,
    createdAt: pr.created_at, syncedAt: new Date().toISOString(),
  });
  const body = pr.body ? pr.body.slice(0, 5000) : '_No description._';
  return `${fm}\n\n# ${pr.title}\n\n**PR #${pr.number}** in \`${repo}\` | ${pr.state} | \`${pr.head.ref}\` -> \`${pr.base.ref}\` | by ${pr.user?.login ?? 'unknown'}\n\n${body}\n`;
}

function buildReadmePage(repo: string, content: string, htmlUrl: string): string {
  const fm = frontmatter({
    title: `${repo} README`, addedBy: 'connector', source: 'github',
    type: 'readme', repo, url: htmlUrl, syncedAt: new Date().toISOString(),
  });
  return `${fm}\n\n${content.slice(0, 10000)}\n`;
}

export async function syncGitHub(options: GitHubSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  callCount = 0;
  const errors: string[] = [];
  let filesWritten = 0;

  const date = todayDate();
  const outDir = join(options.vaultRoot, 'raw', date);
  mkdirSync(outDir, { recursive: true });

  const maxRepos = options.maxRepos ?? 30;
  const maxIssues = options.maxIssuesPerRepo ?? 20;
  const maxPRs = options.maxPRsPerRepo ?? 10;

  // Step 1: Get repos
  let repos: GitHubRepo[] = [];
  if (options.repos && options.repos.length > 0) {
    for (const fullName of options.repos.slice(0, maxRepos)) {
      const { data, error } = await ghFetch<GitHubRepo>(`/repos/${fullName}`, options.token);
      if (error) { errors.push(error); continue; }
      if (data) repos.push(data);
    }
  } else {
    const { data, error } = await ghFetch<GitHubRepo[]>(
      `/user/repos?sort=updated&per_page=${maxRepos}&type=owner`,
      options.token,
    );
    if (error) errors.push(error);
    if (data) repos = data;
  }

  // Step 2: Write repo summaries and fetch details
  for (const repo of repos) {
    const repoDir = join(outDir, 'github', sanitizeFilename(repo.full_name));

    // Repo summary page
    writeMarkdown(repoDir, 'repo.md', buildRepoPage(repo));
    filesWritten++;

    // README
    const { data: readmeData, error: readmeErr } = await ghFetch<{ content: string; html_url: string }>(
      `/repos/${repo.full_name}/readme`,
      options.token,
    );
    if (readmeErr) {
      if (!readmeErr.includes('404')) errors.push(readmeErr);
    } else if (readmeData) {
      try {
        const decoded = Buffer.from(readmeData.content, 'base64').toString('utf-8');
        writeMarkdown(repoDir, 'README.md', buildReadmePage(repo.full_name, decoded, readmeData.html_url));
        filesWritten++;
      } catch (decodeErr) {
        errors.push(`Failed to decode README for ${repo.full_name}`);
      }
    }

    // Issues
    if (repo.open_issues_count > 0) {
      const { data: issues, error: issueErr } = await ghFetch<GitHubIssue[]>(
        `/repos/${repo.full_name}/issues?state=open&per_page=${maxIssues}&sort=updated`,
        options.token,
      );
      if (issueErr) { errors.push(issueErr); }
      if (issues) {
        const issueDir = join(repoDir, 'issues');
        for (const issue of issues) {
          // The issues endpoint includes PRs; skip them
          if ('pull_request' in issue) continue;
          writeMarkdown(issueDir, `issue-${issue.number}.md`, buildIssuePage(repo.full_name, issue));
          filesWritten++;
        }
      }
    }

    // PRs
    const { data: prs, error: prErr } = await ghFetch<GitHubPR[]>(
      `/repos/${repo.full_name}/pulls?state=open&per_page=${maxPRs}&sort=updated`,
      options.token,
    );
    if (prErr) { errors.push(prErr); }
    if (prs) {
      const prDir = join(repoDir, 'prs');
      for (const pr of prs) {
        writeMarkdown(prDir, `pr-${pr.number}.md`, buildPRPage(repo.full_name, pr));
        filesWritten++;
      }
    }

    // Bail early if hitting call cap
    if (callCount >= MAX_TOTAL_CALLS) {
      errors.push(`Stopped after ${repos.indexOf(repo) + 1} repos — API call cap reached`);
      break;
    }
  }

  return {
    provider: 'github',
    filesWritten,
    errors,
    duration: Date.now() - start,
  };
}
