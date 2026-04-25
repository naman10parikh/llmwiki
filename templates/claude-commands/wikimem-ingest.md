---
name: wikimem-ingest
description: Ingest a file, folder, or URL into the WikiMem vault via CLI or MCP tool
---

# /wikimem-ingest

Ingest content into the active WikiMem vault. Accepts a local file path, directory, or URL.

## Usage

```
/wikimem-ingest <source>
```

## What This Does

1. Detects whether `<source>` is a URL or a local path
2. For URLs: uses `wikimem_ingest_url` MCP tool (if connected) or `wikimem scrape <url>` CLI
3. For files/folders: uses `wikimem_ingest` MCP tool (if connected) or `wikimem ingest <path>` CLI
4. Reports pages created and links added
5. Calls `wikimem_status` to confirm the vault grew

## MCP Tool Selection

| Source type | MCP tool             | CLI fallback            |
| ----------- | -------------------- | ----------------------- |
| URL         | `wikimem_ingest_url` | `wikimem scrape <url>`  |
| File/folder | `wikimem_ingest`     | `wikimem ingest <path>` |

## Examples

```bash
# Ingest a single file
/wikimem-ingest ./notes/meeting-2026-04-13.md

# Ingest a URL (uses wikimem_ingest_url MCP tool)
/wikimem-ingest https://arxiv.org/abs/2406.04244

# Ingest an entire folder
/wikimem-ingest ./resources/unread/

# Ingest with tags
wikimem ingest ./doc.md --tags "architecture,agent-runtime"
```

## Implementation

If MCP server is connected and source is a URL:

```
wikimem_ingest_url({ url: "<source>", tags: [...] })
wikimem_status()
```

If MCP server is connected and source is a path:

```
wikimem_ingest({ source: "<path>" })
wikimem_status()
```

CLI fallback:

```bash
VAULT=$(find . -name "AGENTS.md" -maxdepth 3 | head -1 | xargs dirname 2>/dev/null || echo ".")
wikimem ingest "$ARGUMENTS" --vault "$VAULT" --verbose
wikimem status --vault "$VAULT"
```

If `wikimem` is not installed:

```bash
npm install -g wikimem
```

## After Ingest

- Run `/wikimem-status` to see updated vault stats
- Run `/wikimem-ask "What did this document say about X?"` to query the new content
- Run `/wikimem-lint` to check for orphan pages created by the ingest
