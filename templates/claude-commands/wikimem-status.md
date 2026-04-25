---
name: wikimem-status
description: Show WikiMem vault statistics and connector health
---

# /wikimem-status

Show a comprehensive status dashboard for the active WikiMem vault: page counts, word count, connector status, pipeline health, and latest observer score.

## Usage

```
/wikimem-status
```

## What This Does

1. Calls `wikimem_status` — vault stats (pages, words, sources, wikilinks, orphans)
2. Calls `wikimem_list_connectors` — OAuth + folder connector status
3. Calls `wikimem_pipeline` — recent ingest runs and connector health
4. Calls `wikimem_get_report` — latest observer report summary
5. Calls `wikimem_lint` — quick health check (issue count + score)
6. Renders a clean dashboard

## Implementation

If MCP server is connected, batch all five calls in parallel:

```
wikimem_status()           — vault stats
wikimem_list_connectors()  — connector status
wikimem_pipeline()         — recent runs
wikimem_get_report()       — latest observer score
wikimem_lint()             — health check score + issue count (dry run)
```

If running via CLI:

```bash
VAULT=$(find . -name "AGENTS.md" -maxdepth 3 | head -1 | xargs dirname 2>/dev/null || echo ".")
wikimem status --vault "$VAULT" --json
```

## Output Format

```
WikiMem Vault Status
====================
Pages:      47  |  Words: 38,420  |  Sources: 12  |  Wikilinks: 183
Orphans:    2   |  Last updated: 2026-04-13

Connectors
----------
GitHub    connected    last sync: 2h ago   files: 142
Slack     connected    last sync: 6h ago   files: 89
Gmail     NOT CONNECTED  →  /wikimem-sync gmail to connect
Linear    NOT CONNECTED

Pipeline
--------
Last run:  2 hours ago (github sync)  —  3 pages created, 8 links added
Status:    idle

Observer
--------
Last scan: 2026-04-12  |  Avg score: 6.8/10  |  3 weak pages  |  1 orphan
Run /wikimem-improve to refresh
```

## Quick Actions

After seeing status, you can:

- `/wikimem-sync <provider>` to connect and sync a new provider
- `/wikimem-improve` to run the observer
- `/wikimem-ask <question>` to query the vault
- `wikimem serve` to open the full web dashboard
