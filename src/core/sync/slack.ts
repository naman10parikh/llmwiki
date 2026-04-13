/** Slack Sync — fetches channels, messages, users and writes raw markdown for ingest. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SlackSyncOptions {
  token: string;
  vaultRoot: string;
  channels?: string[];
  maxChannels?: number;
  maxMessagesPerChannel?: number;
  since?: string;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface SlackUser {
  id: string; name: string; real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

interface SlackChannel {
  id: string; name: string; num_members?: number;
  topic?: { value: string }; purpose?: { value: string };
}

interface SlackMessage {
  user?: string; text?: string; ts?: string;
  type?: string; subtype?: string; thread_ts?: string; reply_count?: number;
}

interface SlackApiResponse<T> {
  ok: boolean; error?: string;
  response_metadata?: { next_cursor?: string };
  channels?: T[]; messages?: T[]; members?: T[];
}

async function slackApi<T>(
  endpoint: string, token: string, params: Record<string, string> = {},
): Promise<{ data: T | undefined; error: string | undefined }> {
  const url = new URL(`https://slack.com/api/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { data: undefined, error: `HTTP ${res.status}: ${res.statusText}` };

  const json = (await res.json()) as SlackApiResponse<unknown> & T;
  if (!json.ok) return { data: undefined, error: json.error ?? 'Unknown Slack API error' };
  return { data: json as T, error: undefined };
}

type ChannelListResponse = SlackApiResponse<SlackChannel>;
type UserListResponse = SlackApiResponse<SlackUser>;
type HistoryResponse = SlackApiResponse<SlackMessage>;

async function fetchAllChannels(
  token: string, maxChannels: number,
): Promise<{ channels: SlackChannel[]; errors: string[] }> {
  const channels: SlackChannel[] = [];
  const errors: string[] = [];
  let cursor = '';

  while (channels.length < maxChannels) {
    const params: Record<string, string> = {
      types: 'public_channel',
      limit: String(Math.min(200, maxChannels - channels.length)),
      exclude_archived: 'true',
    };
    if (cursor) params['cursor'] = cursor;

    const { data, error } = await slackApi<ChannelListResponse>(
      'conversations.list', token, params,
    );
    if (error) { errors.push(`conversations.list: ${error}`); break; }
    if (data?.channels) channels.push(...(data.channels as unknown as SlackChannel[]));

    cursor = data?.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return { channels: channels.slice(0, maxChannels), errors };
}

async function fetchUserMap(
  token: string,
): Promise<{ userMap: Map<string, string>; errors: string[] }> {
  const userMap = new Map<string, string>();
  const errors: string[] = [];
  let cursor = '';

  for (let page = 0; page < 3; page++) { // 3 pages = 600 users max
    const params: Record<string, string> = { limit: '200' };
    if (cursor) params['cursor'] = cursor;

    const { data, error } = await slackApi<UserListResponse>('users.list', token, params);
    if (error) { errors.push(`users.list: ${error}`); break; }

    if (data?.members) {
      for (const u of data.members as unknown as SlackUser[]) {
        const name = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name;
        userMap.set(u.id, name);
      }
    }
    cursor = data?.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return { userMap, errors };
}

function resolveUserMentions(text: string, userMap: Map<string, string>): string {
  return text.replace(/<@(U[A-Z0-9]+)>/g, (_match, userId: string) => {
    const name = userMap.get(userId);
    return name ? `@${name}` : `@unknown-${userId}`;
  });
}

function tsToIso(ts: string): string {
  const seconds = parseFloat(ts);
  if (Number.isNaN(seconds)) return ts;
  return new Date(seconds * 1000).toISOString();
}

function frontmatter(fields: Record<string, string>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: '${v.replace(/'/g, "''")}'`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

export async function syncSlack(
  options: SlackSyncOptions,
): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;

  const maxChannels = options.maxChannels ?? 10;
  const maxMessages = options.maxMessagesPerChannel ?? 100;
  const sinceTs = options.since
    ? String(new Date(options.since).getTime() / 1000)
    : undefined;

  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = join(options.vaultRoot, 'raw', dateStr);
  mkdirSync(outDir, { recursive: true });

  // 1. Fetch user map for @mention resolution
  const { userMap, errors: userErrors } = await fetchUserMap(options.token);
  errors.push(...userErrors);

  // 2. Fetch channels
  let channels: SlackChannel[];
  if (options.channels && options.channels.length > 0) {
    // Use provided channel IDs — still fetch list to get metadata
    const { channels: allChannels, errors: chErrors } = await fetchAllChannels(
      options.token,
      1000,
    );
    errors.push(...chErrors);
    const targetSet = new Set(options.channels);
    channels = allChannels.filter((c) => targetSet.has(c.id));
  } else {
    const { channels: fetched, errors: chErrors } = await fetchAllChannels(
      options.token,
      maxChannels,
    );
    errors.push(...chErrors);
    channels = fetched;
  }

  // 3. Write channel index
  if (channels.length > 0) {
    const indexLines = [
      frontmatter({ addedBy: 'connector', source: 'slack', type: 'channel-index' }),
      `# Slack Channels (${channels.length})`, '',
    ];
    for (const ch of channels) {
      const purpose = ch.purpose?.value ? ` - ${ch.purpose.value}` : '';
      indexLines.push(`- **#${ch.name}** (${ch.num_members ?? '?'} members)${purpose}`);
    }
    writeFileSync(join(outDir, 'slack-channels.md'), indexLines.join('\n'));
    filesWritten++;
  }

  // 4. Fetch and write history for each channel
  for (const ch of channels) {
    // Auto-join channel if bot isn't a member (requires channels:join scope)
    await slackApi('conversations.join', options.token, { channel: ch.id });

    const params: Record<string, string> = {
      channel: ch.id,
      limit: String(maxMessages),
    };
    if (sinceTs) params['oldest'] = sinceTs;

    const { data, error } = await slackApi<HistoryResponse>(
      'conversations.history',
      options.token,
      params,
    );

    if (error) {
      errors.push(`#${ch.name} history: ${error}`);
      continue;
    }

    const messages = (data?.messages as unknown as SlackMessage[] | undefined) ?? [];
    if (messages.length === 0) continue;

    const lines = [
      frontmatter({ addedBy: 'connector', source: 'slack', channel: ch.name }),
      `# #${ch.name}`, '',
    ];

    // Messages come newest-first from Slack, reverse for chronological
    const sorted = [...messages].reverse();
    for (const msg of sorted) {
      if (!msg.text || msg.subtype === 'channel_join') continue;

      const author = msg.user ? (userMap.get(msg.user) ?? msg.user) : 'bot';
      const time = msg.ts ? tsToIso(msg.ts) : '';
      const resolved = resolveUserMentions(msg.text, userMap);
      const threadTag = msg.reply_count ? ` (${msg.reply_count} replies)` : '';

      lines.push(`**${author}** _${time}_${threadTag}`);
      lines.push(`> ${resolved.replace(/\n/g, '\n> ')}`, '');
    }

    const filename = `slack-${ch.name.replace(/[^a-z0-9-_]/gi, '-')}.md`;
    writeFileSync(join(outDir, filename), lines.join('\n'));
    filesWritten++;
  }

  return {
    provider: 'slack',
    filesWritten,
    errors,
    duration: Date.now() - start,
  };
}
