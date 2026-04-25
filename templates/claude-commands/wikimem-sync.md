---
name: wikimem-sync
description: Sync a connected OAuth provider (Slack, Gmail, GitHub, etc.) into the wiki vault
---

# /wikimem-sync

Trigger a sync from a connected OAuth provider into the WikiMem vault.

## Usage

```
/wikimem-sync <provider>
```

Supported providers: `github` `slack` `gmail` `gdrive` `linear` `notion` `jira`

## What This Does

1. Checks provider connection status via `wikimem_list_connectors`
2. If not connected: shows OAuth instructions via `wikimem_connect`
3. If connected: runs `wikimem_sync` with the provider
4. Reports files written and any errors

## Examples

```
/wikimem-sync slack
/wikimem-sync gmail
/wikimem-sync github
/wikimem-sync gdrive
```

## Implementation

If MCP server is connected:

```
1. wikimem_list_connectors()             — check status
2. wikimem_preview(provider)             — show what would sync (count + cost)
3. Confirm with user if >100 items
4. wikimem_sync(provider, filters)       — run the sync
5. wikimem_status()                      — show updated vault stats
```

If running via CLI:

```bash
wikimem sync $ARGUMENTS
```

## Filters (pass as conversation context)

When syncing, you can add filters to limit scope:

```
/wikimem-sync slack channels:#engineering since:2026-04-01
/wikimem-sync gmail labels:important maxItems:50
/wikimem-sync github repos:naman10parikh/energy
```

## Not Connected?

If a provider isn't connected yet:

1. Run `wikimem serve` to open the web UI
2. Go to Settings → Connectors
3. Click Connect for your provider
4. Authorize via OAuth

Or use the CLI: `wikimem connect <provider>`
