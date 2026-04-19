/** Discord Sync — fetches guilds, channels, messages via bot token and writes raw markdown for ingest. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type Guild,
  type TextChannel,
  type Message,
  type Collection,
} from 'discord.js';
import type { SyncFilters, SyncPreviewResult, PreviewItem } from './sync-filters.js';
import { estimateTokens, formatCostEstimate, isAfterSince } from './sync-filters.js';

export interface DiscordSyncOptions {
  botToken: string;
  vaultRoot: string;
  guildIds?: string[];
  channelIds?: string[];
  maxGuilds?: number;
  maxChannelsPerGuild?: number;
  maxMessagesPerChannel?: number;
  sinceIso?: string;
  includeBotMessages?: boolean;
  filters?: SyncFilters;
}

export interface PlatformSyncResult {
  provider: string;
  filesWritten: number;
  errors: string[];
  duration: number;
}

interface ResolvedGuildChannel {
  guild: Guild;
  channel: TextChannel;
}

function fmYaml(value: string | number): string {
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function frontmatterBlock(fields: Record<string, string | number | string[]>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((item) => fmYaml(item)).join(', ')}]`);
    } else {
      lines.push(`${k}: ${fmYaml(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_]/gi, '-').slice(0, 80);
}

async function createBotClient(botToken: string): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(botToken);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Discord client failed to become ready within 15s'));
    }, 15_000);
    client.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return client;
}

function selectGuilds(client: Client, guildIdFilter: string[] | undefined, max: number): Guild[] {
  const guilds = [...client.guilds.cache.values()];
  if (guildIdFilter && guildIdFilter.length > 0) {
    const want = new Set(guildIdFilter);
    return guilds.filter((g) => want.has(g.id) || want.has(g.name)).slice(0, max);
  }
  return guilds.slice(0, max);
}

function listTextChannels(guild: Guild, channelIdFilter: string[] | undefined, max: number): TextChannel[] {
  const all = [...guild.channels.cache.values()];
  const textual = all.filter(
    (c): c is TextChannel => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
  );
  if (channelIdFilter && channelIdFilter.length > 0) {
    const want = new Set(channelIdFilter);
    return textual.filter((c) => want.has(c.id) || want.has(c.name)).slice(0, max);
  }
  return textual.slice(0, max);
}

function resolveMentions(content: string, guild: Guild): string {
  let out = content.replace(/<@!?(\d+)>/g, (_m, userId: string) => {
    const member = guild.members.cache.get(userId);
    const user = member?.user ?? guild.client.users.cache.get(userId);
    const name = member?.displayName ?? user?.username;
    return name ? `@${name}` : `@unknown-${userId}`;
  });
  out = out.replace(/<#(\d+)>/g, (_m, channelId: string) => {
    const ch = guild.channels.cache.get(channelId);
    return ch ? `#${ch.name}` : `#unknown-${channelId}`;
  });
  out = out.replace(/<@&(\d+)>/g, (_m, roleId: string) => {
    const role = guild.roles.cache.get(roleId);
    return role ? `@${role.name}` : `@role-${roleId}`;
  });
  return out;
}

async function fetchChannelMessages(
  channel: TextChannel,
  maxMessages: number,
  sinceMs: number | undefined,
): Promise<{ messages: Message[]; error: string | undefined }> {
  const collected: Message[] = [];
  let beforeId: string | undefined;
  const pageSize = 100;

  try {
    while (collected.length < maxMessages) {
      const remaining = maxMessages - collected.length;
      const limit = Math.min(pageSize, remaining);
      const fetchOptions: { limit: number; before?: string } = { limit };
      if (beforeId) fetchOptions.before = beforeId;

      const batch: Collection<string, Message> = await channel.messages.fetch(fetchOptions);
      if (batch.size === 0) break;

      const batchArr = [...batch.values()];
      let hitSince = false;
      for (const msg of batchArr) {
        if (sinceMs !== undefined && msg.createdTimestamp < sinceMs) {
          hitSince = true;
          break;
        }
        collected.push(msg);
      }

      const lastMsg = batchArr[batchArr.length - 1];
      if (!lastMsg || hitSince || batch.size < limit) break;
      beforeId = lastMsg.id;
    }
    return { messages: collected, error: undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { messages: collected, error: msg };
  }
}

function formatMessage(msg: Message, guild: Guild): string {
  const username = msg.author.username;
  const iso = new Date(msg.createdTimestamp).toISOString();
  const body = resolveMentions(msg.content || '', guild);

  const lines = [`**@${username}** (${iso}):`, body || '_(no content)_'];

  if (msg.attachments.size > 0) {
    lines.push('', 'Attachments:');
    for (const att of msg.attachments.values()) {
      lines.push(`- ${att.url}`);
    }
  }
  lines.push('', '---', '');
  return lines.join('\n');
}

export async function previewDiscord(options: DiscordSyncOptions): Promise<SyncPreviewResult> {
  const errors: string[] = [];
  const filters = options.filters ?? {};
  const maxGuilds = options.maxGuilds ?? 10;
  const maxChannelsPerGuild = filters.maxItems ?? options.maxChannelsPerGuild ?? 20;

  let client: Client | undefined;
  try {
    client = await createBotClient(options.botToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: 'discord',
      totalItems: 0,
      items: [],
      estimatedTokens: 0,
      costEstimate: '0 tokens',
      errors: [`Discord login failed: ${msg}`],
    };
  }

  try {
    const guilds = selectGuilds(client, options.guildIds, maxGuilds);
    const items: PreviewItem[] = [];

    for (const guild of guilds) {
      let channels: TextChannel[];
      try {
        channels = listTextChannels(guild, filters.channels ?? options.channelIds, maxChannelsPerGuild);
      } catch (err) {
        errors.push(`list channels for ${guild.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const ch of channels) {
        const me = guild.members.me;
        const perms = me ? ch.permissionsFor(me) : null;
        if (perms && !perms.has('ViewChannel')) continue;

        items.push({
          id: ch.id,
          title: `${guild.name} — #${ch.name}`,
          date: new Date(ch.createdTimestamp ?? Date.now()).toISOString(),
          type: 'channel',
          sizeEstimate: 5000,
          meta: {
            guild: guild.name,
            guildId: guild.id,
            channel: ch.name,
          },
        });
      }
    }

    const totalChars = items.reduce((sum, i) => sum + i.sizeEstimate, 0);
    const tokens = estimateTokens(totalChars, items.length);
    return {
      provider: 'discord',
      totalItems: items.length,
      items,
      estimatedTokens: tokens,
      costEstimate: formatCostEstimate(tokens),
      errors,
    };
  } finally {
    await client.destroy();
  }
}

export async function syncDiscord(options: DiscordSyncOptions): Promise<PlatformSyncResult> {
  const start = Date.now();
  const errors: string[] = [];
  let filesWritten = 0;
  const filters = options.filters ?? {};

  if (filters.preview) {
    const preview = await previewDiscord(options);
    return {
      provider: 'discord',
      filesWritten: 0,
      errors: preview.errors,
      duration: Date.now() - start,
    };
  }

  const maxGuilds = options.maxGuilds ?? 10;
  const maxChannelsPerGuild = filters.maxItems ?? options.maxChannelsPerGuild ?? 20;
  const maxMessages = options.maxMessagesPerChannel ?? 100;
  const includeBotMessages = options.includeBotMessages ?? false;
  const sinceStr = filters.since ?? options.sinceIso;
  const sinceMs = sinceStr ? new Date(sinceStr).getTime() : undefined;

  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = join(options.vaultRoot, 'raw', dateStr);
  mkdirSync(outDir, { recursive: true });

  let client: Client;
  try {
    client = await createBotClient(options.botToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Discord login failed: ${msg}`);
  }

  try {
    const guilds = selectGuilds(client, options.guildIds, maxGuilds);
    if (options.guildIds) {
      const foundIds = new Set(guilds.map((g) => g.id));
      for (const wanted of options.guildIds) {
        if (!foundIds.has(wanted) && !guilds.some((g) => g.name === wanted)) {
          errors.push(`Bot not in guild: ${wanted} (skipping)`);
        }
      }
    }

    if (guilds.length > 0) {
      const indexLines = [
        frontmatterBlock({
          addedBy: 'connector',
          source: 'discord',
          type: 'guild-index',
          guild_count: guilds.length,
        }),
        `# Discord Guilds (${guilds.length})`,
        '',
      ];
      for (const g of guilds) {
        indexLines.push(`- **${g.name}** (id: ${g.id}, ${g.memberCount ?? '?'} members)`);
      }
      writeFileSync(join(outDir, 'discord-guilds.md'), indexLines.join('\n'));
      filesWritten++;
    }

    for (const guild of guilds) {
      const resolvedChannels: ResolvedGuildChannel[] = [];
      try {
        const chans = listTextChannels(guild, filters.channels ?? options.channelIds, maxChannelsPerGuild);
        for (const c of chans) resolvedChannels.push({ guild, channel: c });
      } catch (err) {
        errors.push(`list channels for ${guild.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const { channel } of resolvedChannels) {
        const me = guild.members.me;
        const perms = me ? channel.permissionsFor(me) : null;
        if (perms && (!perms.has('ViewChannel') || !perms.has('ReadMessageHistory'))) {
          errors.push(`#${channel.name} (${guild.name}): permission denied (skipping)`);
          continue;
        }

        const { messages, error } = await fetchChannelMessages(channel, maxMessages, sinceMs);
        if (error) {
          errors.push(`#${channel.name} (${guild.name}) fetch: ${error}`);
          if (messages.length === 0) continue;
        }

        const filtered = messages.filter((m) => includeBotMessages || !m.author.bot);
        const withinSince = filtered.filter((m) =>
          isAfterSince(new Date(m.createdTimestamp).toISOString(), sinceStr),
        );
        if (withinSince.length === 0) continue;

        const chronological = [...withinSince].reverse();
        const firstIso = new Date(chronological[0]?.createdTimestamp ?? Date.now()).toISOString();

        const lines = [
          frontmatterBlock({
            title: `Discord — ${guild.name} — #${channel.name}`,
            source: 'discord',
            guild: guild.name,
            guild_id: guild.id,
            channel: channel.name,
            channel_id: channel.id,
            created: firstIso,
            message_count: chronological.length,
            tags: ['discord', 'chat'],
          }),
          `# #${channel.name} — ${guild.name}`,
          '',
        ];
        for (const msg of chronological) {
          lines.push(formatMessage(msg, guild));
        }

        const filename = `discord-${sanitizeFilename(guild.name)}-${sanitizeFilename(channel.name)}.md`;
        writeFileSync(join(outDir, filename), lines.join('\n'));
        filesWritten++;
      }
    }

    return {
      provider: 'discord',
      filesWritten,
      errors,
      duration: Date.now() - start,
    };
  } finally {
    await client.destroy();
  }
}
