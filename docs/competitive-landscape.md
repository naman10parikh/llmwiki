# Competitive Landscape — April 7, 2026

> 40+ repos spawned in 3 days from Karpathy's LLM Wiki gist. 7,882+ X posts.

## Top Competitors

| # | Project | Stars | Key Strength | Our Advantage |
|---|---------|-------|-------------|---------------|
| 1 | sage-wiki (Go) | 186 | 12+ formats, hybrid search, MCP, web UI | We have self-improvement + scraping |
| 2 | claude-memory-compiler | 206 | Auto-capture sessions via hooks | We have full wiki compilation, not just session capture |
| 3 | nvk/llm-wiki | 129 | Claude plugin, parallel research | We're standalone CLI + multi-provider |
| 4 | llm-wiki-skill | 272 | Multi-platform (Claude/Codex/OpenClaw) | We have all 3 automations |
| 5 | obsidian-wiki | 173 | 6-agent compatibility | We have self-improvement loop |
| 6 | atomicmemory/llm-wiki-compiler | 176 | Hash-based incremental compilation | We have multi-modal + scraping |

## Feature Gaps We Fill

1. **Self-improvement (LLM Council)** — Nobody has automated wiki quality scoring + improvement
2. **External source scraping** — Nobody auto-fetches from X/GitHub/RSS with user auth
3. **Multi-modal processing** — Nobody handles video+audio+image→markdown
4. **Semantic dedup** — Nobody rejects duplicate content with reasoning

## Key Tools to Integrate

- **qmd** (19,408 stars) — Search engine with MCP server, BM25+vector+LLM reranking
- **LLM Council** (16,749 stars) — 3-stage multi-model deliberation for quality review
- **MiniSearch** (5,885 stars) — Client-side instant search (7KB, TypeScript-first)
- **SuperMemory** (21,418 stars) — Memory API, #1 on all 3 benchmarks

## Consensus

- "No RAG" is universal — all reject RAG for personal scale
- Obsidian is the default viewer (~70% of projects)
- Multi-platform support is table stakes
- The "compile once, query forever" pattern is validated
