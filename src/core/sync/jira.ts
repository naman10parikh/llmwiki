/**
 * Jira sync — fetches issues via Atlassian Cloud REST API v3, writes markdown to vault.
 * Uses OAuth access_token from .wikimem/tokens.json.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformSyncResult } from './index.js';

export interface JiraSyncOptions {
  token: string;
  vaultRoot: string;
  /** Override auto-detected cloudId (skips accessible-resources call) */
  cloudId?: string;
  /** JQL filter override. Default: issues updated in last 7 days */
  jql?: string;
  /** Max issues to fetch per sync. Default: 50 */
  maxResults?: number;
  /** Only sync issues from these projects (keys like "ENG", "PROD") */
  projectKeys?: string[];
}

interface JiraAccessibleResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary: string;
    status: { name: string };
    issuetype: { name: string };
    priority: { name: string } | null;
    assignee: { displayName: string } | null;
    reporter: { displayName: string } | null;
    labels: string[];
    description: JiraAdfNode | null;
    comment: {
      comments: JiraComment[];
      total: number;
    };
    created: string;
    updated: string;
    project: { key: string; name: string };
  };
}

interface JiraComment {
  author: { displayName: string };
  body: JiraAdfNode | null;
  created: string;
}

/** Atlassian Document Format node (simplified) */
interface JiraAdfNode {
  type: string;
  text?: string;
  content?: JiraAdfNode[];
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

const ATLASSIAN_AUTH_API = 'https://api.atlassian.com/oauth/token/accessible-resources';

function jiraApi(cloudId: string): string {
  return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
}

async function atlassianFetch<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Jira API ${res.status}: ${res.statusText} (${url})`);
  }
  return res.json() as Promise<T>;
}

/** Resolve the first accessible Jira cloud instance for this token. */
async function resolveCloudId(token: string): Promise<string> {
  const resources = await atlassianFetch<JiraAccessibleResource[]>(ATLASSIAN_AUTH_API, token);
  if (resources.length === 0) {
    throw new Error('No accessible Jira sites found for this token.');
  }
  return resources[0]!.id;
}

/** Flatten Atlassian Document Format (ADF) into plain markdown text. */
function adfToMarkdown(node: JiraAdfNode | null): string {
  if (!node) return '*No description*';
  if (node.text) return node.text;
  if (!node.content) return '';

  return node.content
    .map((child) => {
      switch (child.type) {
        case 'paragraph':
          return adfToMarkdown(child) + '\n';
        case 'heading': {
          const level = '#'.repeat(Math.min((child as { attrs?: { level?: number } }).attrs?.level ?? 3, 6));
          return `${level} ${adfToMarkdown(child)}\n`;
        }
        case 'bulletList':
          return (child.content ?? []).map((li) => `- ${adfToMarkdown(li)}`).join('\n') + '\n';
        case 'orderedList':
          return (child.content ?? []).map((li, i) => `${i + 1}. ${adfToMarkdown(li)}`).join('\n') + '\n';
        case 'listItem':
          return adfToMarkdown(child);
        case 'codeBlock':
          return '```\n' + adfToMarkdown(child) + '\n```\n';
        case 'blockquote':
          return adfToMarkdown(child)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n') + '\n';
        case 'hardBreak':
          return '\n';
        case 'text':
          return child.text ?? '';
        default:
          return adfToMarkdown(child);
      }
    })
    .join('');
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function fm(fields: Record<string, string | number | string[]>): string {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map((s) => `'${s}'`).join(', ')}]`;
    return typeof v === 'number' ? `${k}: ${v}` : `${k}: '${v}'`;
  });
  return ['---', ...lines, '---'].join('\n');
}

function issueToMarkdown(issue: JiraIssue): string {
  const { fields } = issue;
  const assignee = fields.assignee?.displayName ?? 'unassigned';
  const reporter = fields.reporter?.displayName ?? 'unknown';
  const priority = fields.priority?.name ?? 'none';

  const frontmatter = fm({
    addedBy: 'connector',
    source: 'jira',
    type: 'issue',
    state: fields.status.name,
    issueType: fields.issuetype.name,
    priority,
    assignee,
    reporter,
    labels: fields.labels,
    project: fields.project.key,
    jiraKey: issue.key,
    createdAt: fields.created,
    updatedAt: fields.updated,
  });

  const meta = [
    `**Status:** ${fields.status.name}`,
    `**Type:** ${fields.issuetype.name}`,
    `**Priority:** ${priority}`,
    `**Assignee:** ${assignee}`,
    `**Reporter:** ${reporter}`,
    `**Project:** ${fields.project.name} (${fields.project.key})`,
  ].join(' | ');

  const labelLine = fields.labels.length > 0 ? `**Labels:** ${fields.labels.join(', ')}\n\n` : '';
  const description = adfToMarkdown(fields.description);

  let commentsSection = '';
  if (fields.comment.comments.length > 0) {
    const commentLines = fields.comment.comments.map((c) => {
      const date = c.created.slice(0, 10);
      const body = adfToMarkdown(c.body);
      return `> **${c.author.displayName}** (${date}):\n> ${body.trim().replace(/\n/g, '\n> ')}`;
    });
    commentsSection = `\n## Comments\n\n${commentLines.join('\n\n')}\n`;
  }

  return [
    frontmatter,
    '',
    `# [${issue.key}] ${fields.summary}`,
    '',
    meta,
    '',
    labelLine + description,
    commentsSection,
    '---',
    `*Synced from Jira*`,
    '',
  ].join('\n');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function syncJira(options: JiraSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;
  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(options.vaultRoot, 'raw', date);
  ensureDir(outDir);

  // Step 1: Resolve cloud ID
  let cloudId: string;
  try {
    cloudId = options.cloudId ?? await resolveCloudId(options.token);
  } catch (err: unknown) {
    errors.push(`Cloud ID resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    return { provider: 'jira', filesWritten, errors, duration: Date.now() - start };
  }

  // Step 2: Build JQL and fetch issues
  const maxResults = options.maxResults ?? 50;
  let jql = options.jql ?? 'updated >= -7d ORDER BY updated DESC';
  if (!options.jql && options.projectKeys?.length) {
    const projectFilter = options.projectKeys.map((k) => `"${k}"`).join(', ');
    jql = `project IN (${projectFilter}) AND updated >= -7d ORDER BY updated DESC`;
  }

  try {
    const searchUrl = `${jiraApi(cloudId)}/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status,issuetype,priority,assignee,reporter,labels,description,comment,created,updated,project`;
    const searchResult = await atlassianFetch<JiraSearchResponse>(searchUrl, options.token);

    for (const issue of searchResult.issues) {
      const filename = `jira-${issue.key.toLowerCase()}-${slugify(issue.fields.summary)}.md`;
      writeFileSync(join(outDir, filename), issueToMarkdown(issue), 'utf-8');
      filesWritten++;
    }
  } catch (err: unknown) {
    errors.push(`Issues fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { provider: 'jira', filesWritten, errors, duration: Date.now() - start };
}
