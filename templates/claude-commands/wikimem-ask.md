---
name: wikimem-ask
description: Query the WikiMem vault with a natural language question
---

# /wikimem-ask

Ask a natural language question against the active WikiMem vault. Uses BM25 retrieval + LLM synthesis to return an answer with citations to wiki pages.

## Usage

```
/wikimem-ask <question>
```

## What This Does

1. Searches the vault for pages relevant to the question
2. Synthesizes an answer from retrieved context
3. Returns the answer with citations (wiki page titles)
4. Optionally files the answer back as a synthesis page

## Examples

```
/wikimem-ask "What did I email Sarah about last month?"
/wikimem-ask "What is our agent runtime architecture?"
/wikimem-ask "What are the key decisions we made about the database schema?"
/wikimem-ask "Summarize what I know about prompt caching"
```

## Implementation

```bash
# Detect vault root
VAULT=$(find . -name "AGENTS.md" -maxdepth 3 | head -1 | xargs dirname 2>/dev/null || echo ".")

# Run ask
wikimem ask "$ARGUMENTS" --vault "$VAULT"
```

If the MCP server is connected, prefer `wikimem_ask` (single round-trip, LLM synthesis included):

```
wikimem_ask({ question: "<question>", searchMode: "bm25" })
```

Alternatively, use the search+read+synthesise pattern manually:

1. Call `wikimem_search` with the question as query (limit 5)
2. Call `wikimem_read` on the top results
3. Synthesize an answer with citations to the page titles

## Flags

```bash
# File the answer back as a synthesis page
wikimem ask "What patterns did we find?" --file-back

# Use semantic search instead of BM25
wikimem ask "Compare memory approaches" --search-mode semantic

# JSON output
wikimem ask "What is X?" --json
```

## Tips

- Questions work best when they match topics in ingested content
- For fuzzy/semantic questions, use `--search-mode semantic`
- Use `--file-back` to build up a synthesis layer over time
