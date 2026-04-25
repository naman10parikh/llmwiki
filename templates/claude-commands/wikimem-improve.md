---
name: wikimem-improve
description: Run the WikiMem observer/self-improvement engine on the vault
---

# /wikimem-improve

Trigger the WikiMem observer: scores all pages for quality, finds orphans and contradictions, identifies knowledge gaps, and optionally auto-improves weak pages using LLM.

## Usage

```
/wikimem-improve
```

## What This Does

1. Calls `wikimem_run_observer` (or `wikimem improve` CLI)
2. Scores every page: freshness, readability, cross-linking, tags, depth
3. Reports: weak pages, orphan pages, knowledge gaps, contradictions
4. Shows top issues and cross-link opportunities
5. Summarizes any auto-improvements applied

## Implementation

If MCP server is connected:

```
1. wikimem_get_report()        — check if a recent report exists
2. wikimem_run_observer({ autoImprove: false, budget: 1.0 })
3. Show summary: avg score, weak pages, orphans, gaps
4. Ask: "Auto-improve the 3 weakest pages? (uses LLM)"
5. If yes: wikimem_run_observer({ autoImprove: true, maxPages: 10, budget: 2.0 })
```

If running via CLI:

```bash
VAULT=$(find . -name "AGENTS.md" -maxdepth 3 | head -1 | xargs dirname 2>/dev/null || echo ".")
wikimem improve --vault "$VAULT" --max-pages 100 --max-budget 1.00
```

## Output Format

```
Observer Report — 2026-04-13
Pages reviewed: 47/47  |  Avg score: 6.2/10
Weak pages (< 60%): 8
Orphan pages: 3
Knowledge gaps: 5
Top issues: missing summary (12), no tags (8), low word count (6)

Auto-improve 3 weakest pages? [y/n]
```

## Flags

```bash
# Dry run (no LLM calls)
wikimem improve --dry-run

# Limit pages reviewed
wikimem improve --max-pages 50

# Set budget cap
wikimem improve --max-budget 0.50

# Max pages to auto-improve
wikimem improve --max-improvements 5
```

## Schedule Nightly

```bash
# Add to crontab (3am daily)
0 3 * * * cd /path/to/wiki && wikimem improve --max-improvements 5
```
