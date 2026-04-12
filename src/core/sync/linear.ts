/**
 * Linear sync — fetches issues and projects via GraphQL, writes markdown to vault.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LinearSyncOptions {
  token: string;
  vaultRoot: string;
  maxIssues?: number;
  teamId?: string;
  includeCompleted?: boolean;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface LinearIssueNode {
  id: string;
  title: string;
  description: string | null;
  state: { name: string };
  assignee: { name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface LinearProjectNode {
  id: string;
  name: string;
  description: string | null;
  state: string;
  progress: number;
  startDate: string | null;
  targetDate: string | null;
  lead: { name: string } | null;
  url: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const LINEAR_API = 'https://api.linear.app/graphql';

function buildIssuesQuery(opts: LinearSyncOptions): string {
  const limit = opts.maxIssues ?? 50;
  const completedFilter = opts.includeCompleted
    ? ''
    : 'state: { type: { nin: ["completed", "canceled"] } }';
  const teamFilter = opts.teamId ? `team: { id: { eq: "${opts.teamId}" } }` : '';
  const filters = [teamFilter, completedFilter].filter(Boolean).join(', ');
  const filterArg = filters ? `, filter: { ${filters} }` : '';

  return `query { issues(first: ${limit}, orderBy: updatedAt${filterArg}) {
    nodes { id title description state { name } assignee { name }
      labels { nodes { name } } priority priorityLabel createdAt updatedAt url }
  } }`;
}

const PROJECTS_QUERY = `query { projects(first: 20, filter: { state: { eq: "started" } }) {
  nodes { id name description state progress startDate targetDate lead { name } url }
} }`;

async function gql<T>(token: string, query: string): Promise<GraphQLResponse<T>> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<GraphQLResponse<T>>;
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

function issueToMarkdown(issue: LinearIssueNode): string {
  const labels = issue.labels.nodes.map((l) => l.name);
  const assignee = issue.assignee?.name ?? 'unassigned';
  const frontmatter = fm({
    addedBy: 'connector', source: 'linear', type: 'issue',
    state: issue.state.name, priority: issue.priorityLabel, assignee,
    labels, linearId: issue.id, url: issue.url,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  });
  const meta = `**State:** ${issue.state.name} | **Priority:** ${issue.priorityLabel} | **Assignee:** ${assignee}`;
  const labelLine = labels.length > 0 ? `**Labels:** ${labels.join(', ')}\n\n` : '';
  const desc = issue.description ?? '*No description*';
  return `${frontmatter}\n\n# ${issue.title}\n\n${meta}\n\n${labelLine}${desc}\n\n---\n[View in Linear](${issue.url})\n`;
}

function projectToMarkdown(project: LinearProjectNode): string {
  const pct = Math.round(project.progress * 100);
  const lead = project.lead?.name ?? 'unassigned';
  const frontmatter = fm({
    addedBy: 'connector', source: 'linear', type: 'project',
    state: project.state, progress: pct, lead, linearId: project.id, url: project.url,
  });
  const meta = `**Progress:** ${pct}% | **Lead:** ${lead}`;
  const timeline = project.startDate || project.targetDate
    ? `\n**Timeline:** ${project.startDate ?? '?'} → ${project.targetDate ?? '?'}\n`
    : '';
  const desc = project.description ?? '*No description*';
  return `${frontmatter}\n\n# ${project.name}\n\n${meta}${timeline}\n${desc}\n\n---\n[View in Linear](${project.url})\n`;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function syncLinear(options: LinearSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;
  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(options.vaultRoot, 'raw', date);
  ensureDir(outDir);

  // Sync issues
  try {
    const res = await gql<{ issues: { nodes: LinearIssueNode[] } }>(options.token, buildIssuesQuery(options));
    if (res.errors?.length) errors.push(...res.errors.map((e) => `Issues: ${e.message}`));
    for (const issue of res.data?.issues.nodes ?? []) {
      writeFileSync(join(outDir, `linear-issue-${slugify(issue.title)}.md`), issueToMarkdown(issue), 'utf-8');
      filesWritten++;
    }
  } catch (err: unknown) {
    errors.push(`Issues fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Sync projects
  try {
    const res = await gql<{ projects: { nodes: LinearProjectNode[] } }>(options.token, PROJECTS_QUERY);
    if (res.errors?.length) errors.push(...res.errors.map((e) => `Projects: ${e.message}`));
    for (const project of res.data?.projects.nodes ?? []) {
      writeFileSync(join(outDir, `linear-project-${slugify(project.name)}.md`), projectToMarkdown(project), 'utf-8');
      filesWritten++;
    }
  } catch (err: unknown) {
    errors.push(`Projects fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { provider: 'linear', filesWritten, errors, duration: Date.now() - start };
}
