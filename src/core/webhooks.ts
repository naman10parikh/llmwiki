import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookPayload {
  provider: string;
  event: string;
  title: string;
  content: string;
  metadata: Record<string, string>;
  rawBody?: string;
}

// ── HMAC helpers ────────────────────────────────────────────────────────────

function verifyHmacSha256(body: string, secret: string, signature: string, prefix = ''): boolean {
  try {
    const expected = prefix + createHmac('sha256', secret).update(body, 'utf-8').digest('hex');
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(signature, 'utf-8'));
  } catch {
    return false;
  }
}

function safeStringify(body: unknown): string {
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

interface GitHubCommit {
  id?: string;
  message?: string;
  author?: { name?: string };
  url?: string;
}

interface GitHubIssueOrPR {
  title?: string;
  body?: string;
  html_url?: string;
  number?: number;
  user?: { login?: string };
  state?: string;
  merged?: boolean;
}

interface GitHubPushPayload {
  ref?: string;
  commits?: GitHubCommit[];
  repository?: { full_name?: string };
  pusher?: { name?: string };
}

interface GitHubIssuePayload {
  action?: string;
  issue?: GitHubIssueOrPR;
  repository?: { full_name?: string };
}

interface GitHubPRPayload {
  action?: string;
  pull_request?: GitHubIssueOrPR;
  repository?: { full_name?: string };
}

export function parseGitHubWebhook(
  headers: Record<string, string>,
  body: unknown,
  secret?: string,
): WebhookPayload | null {
  try {
    const rawBody = safeStringify(body);
    if (secret) {
      const sig = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'] ?? '';
      if (!sig || !verifyHmacSha256(rawBody, secret, sig, 'sha256=')) return null;
    }

    const event = headers['x-github-event'] ?? headers['X-GitHub-Event'] ?? '';
    const data = (typeof body === 'string' ? JSON.parse(body) : body) as Record<string, unknown>;

    if (event === 'push') {
      const push = data as unknown as GitHubPushPayload;
      const commits = push.commits ?? [];
      const commitLines = commits
        .map((c) => `- \`${(c.id ?? '').slice(0, 7)}\` ${c.message ?? '(no message)'} (${c.author?.name ?? 'unknown'})`)
        .join('\n');
      return {
        provider: 'github',
        event: 'push',
        title: `Push to ${push.ref ?? 'unknown'} in ${push.repository?.full_name ?? 'unknown'}`,
        content: commitLines || '(no commits)',
        metadata: {
          ref: String(push.ref ?? ''),
          repo: String(push.repository?.full_name ?? ''),
          pusher: String(push.pusher?.name ?? ''),
          commitCount: String(commits.length),
        },
        rawBody,
      };
    }

    if (event === 'issues') {
      const iss = data as unknown as GitHubIssuePayload;
      const issue = iss.issue;
      if (!issue) return null;
      return {
        provider: 'github',
        event: `issues.${iss.action ?? 'unknown'}`,
        title: `Issue #${issue.number ?? '?'}: ${issue.title ?? '(untitled)'}`,
        content: issue.body ?? '(no body)',
        metadata: {
          action: String(iss.action ?? ''),
          repo: String(iss.repository?.full_name ?? ''),
          author: String(issue.user?.login ?? ''),
          url: String(issue.html_url ?? ''),
          state: String(issue.state ?? ''),
        },
        rawBody,
      };
    }

    if (event === 'pull_request') {
      const pr = data as unknown as GitHubPRPayload;
      const pull = pr.pull_request;
      if (!pull) return null;
      const action = pr.action === 'closed' && pull.merged ? 'merged' : (pr.action ?? 'unknown');
      return {
        provider: 'github',
        event: `pull_request.${action}`,
        title: `PR #${pull.number ?? '?'}: ${pull.title ?? '(untitled)'}`,
        content: pull.body ?? '(no body)',
        metadata: {
          action,
          repo: String(pr.repository?.full_name ?? ''),
          author: String(pull.user?.login ?? ''),
          url: String(pull.html_url ?? ''),
          state: String(pull.state ?? ''),
        },
        rawBody,
      };
    }

    // Unsupported GitHub event
    return null;
  } catch {
    return null;
  }
}

// ── Slack ───────────────────────────────────────────────────────────────────

interface SlackEventCallback {
  type: 'event_callback';
  event?: { type?: string; text?: string; user?: string; channel?: string; ts?: string };
  team_id?: string;
}

interface SlackUrlVerification {
  type: 'url_verification';
  challenge?: string;
}

type SlackBody = SlackEventCallback | SlackUrlVerification | Record<string, unknown>;

export function parseSlackWebhook(
  headers: Record<string, string>,
  body: unknown,
): WebhookPayload | null {
  try {
    const data = (typeof body === 'string' ? JSON.parse(body) : body) as SlackBody;
    const rawBody = safeStringify(body);

    // URL verification challenge — return a payload the caller can detect
    if ('type' in data && data.type === 'url_verification') {
      const challenge = (data as SlackUrlVerification).challenge ?? '';
      return {
        provider: 'slack',
        event: 'url_verification',
        title: 'Slack URL Verification',
        content: challenge,
        metadata: { challenge },
        rawBody,
      };
    }

    // Slash command format (form-encoded parsed to object)
    if ('command' in data && typeof (data as Record<string, unknown>)['command'] === 'string') {
      const cmd = data as Record<string, string>;
      return {
        provider: 'slack',
        event: 'slash_command',
        title: `Slash command: ${cmd['command'] ?? '/unknown'}`,
        content: cmd['text'] ?? '',
        metadata: {
          command: String(cmd['command'] ?? ''),
          user: String(cmd['user_name'] ?? ''),
          channel: String(cmd['channel_name'] ?? ''),
          team: String(cmd['team_domain'] ?? ''),
        },
        rawBody,
      };
    }

    // Event callback
    if ('type' in data && data.type === 'event_callback') {
      const ecb = data as SlackEventCallback;
      const evt = ecb.event;
      if (!evt) return null;
      return {
        provider: 'slack',
        event: `event.${evt.type ?? 'unknown'}`,
        title: `Slack ${evt.type ?? 'event'} in ${evt.channel ?? 'unknown'}`,
        content: evt.text ?? '',
        metadata: {
          eventType: String(evt.type ?? ''),
          user: String(evt.user ?? ''),
          channel: String(evt.channel ?? ''),
          ts: String(evt.ts ?? ''),
          team: String(ecb.team_id ?? ''),
        },
        rawBody,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ── Generic ─────────────────────────────────────────────────────────────────

interface GenericBody {
  title?: string;
  content?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

export function parseGenericWebhook(
  body: unknown,
  secret?: string,
  signature?: string,
): WebhookPayload | null {
  try {
    const rawBody = safeStringify(body);
    if (secret && signature) {
      if (!verifyHmacSha256(rawBody, secret, signature)) return null;
    }

    const data = (typeof body === 'string' ? JSON.parse(body) : body) as GenericBody;
    if (!data.content && !data.title) return null;

    return {
      provider: data.source ?? 'generic',
      event: 'ingest',
      title: data.title ?? `Webhook Ingest ${new Date().toISOString()}`,
      content: data.content ?? '',
      metadata: {
        ...data.metadata,
        ...(data.tags?.length ? { tags: data.tags.join(', ') } : {}),
      },
      rawBody,
    };
  } catch {
    return null;
  }
}

// ── Markdown conversion ─────────────────────────────────────────────────────

export function webhookToMarkdown(payload: WebhookPayload): string {
  const receivedAt = new Date().toISOString();
  const metaEntries = Object.entries(payload.metadata).filter(([, v]) => v);
  const metaBlock = metaEntries.length > 0
    ? `\n## Metadata\n${metaEntries.map(([k, v]) => `- **${k}:** ${v}`).join('\n')}\n`
    : '';

  return `---
addedBy: webhook
source: ${payload.provider}
event: ${payload.event}
receivedAt: ${receivedAt}
---
# ${payload.title}

${payload.content}
${metaBlock}`;
}
