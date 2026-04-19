# Product Hunt Submission — WikiMem

## Tagline (60 char max)

> Self-improving LLM wiki with 38 connectors

(44 chars. Alternates kept in case the team wants to A/B:)

- `Compile your files into a self-improving wiki` — 47 chars
- `The wiki that reads your sources so you don't` — 46 chars
- `An LLM wiki that maintains itself` — 33 chars

---

## Description (1-2 sentences)

WikiMem compiles your PDFs, audio, URLs, and 38 OAuth-connected sources into a structured wiki of entity, concept, and source pages — then a self-improving Observer scores quality nightly and fixes the worst pages under a capped budget. Ships with a 19-tool MCP server for Claude Code and Cursor. `npx wikimem` and you're running. MIT.

---

## First Comment (hunter-style intro, 100-200 words)

Hi Product Hunt — Naman here.

I built WikiMem because knowledge kept accumulating without compounding. PDFs I'd read once, audio from calls I never transcribed, URLs bookmarked and forgotten, Slack exports in a drawer.

The standard answer is RAG, but RAG retrieves paragraphs at query time. I wanted something that compiled my sources upfront into structured, browsable pages — the way Karpathy described in his LLM wiki tweet on April 7. So I built it. Ten days later, here we are.

Three things I'm proud of:

1. **The Observer** — scores your vault on 24 points nightly and rewrites the weakest pages, capped at ~11 LLM calls and $2 per run so it never runs away.
2. **The MCP server** — 19 tools. Five lines in `.mcp.json` and Claude Code reads your compiled knowledge in every session.
3. **38 working connectors** — GitHub, Slack, Gmail, Notion, Discord, Drive, Linear, Jira, and 30 more, all dispatching through the same ingest pipeline.

MIT, local-first, Obsidian-compatible. Try it: `npx wikimem`.

I'll be here answering questions all day.

---

## Gallery Caption Ideas (one per screenshot, pick 5)

**1. Hero — Web IDE**

> The full IDE at localhost:3141. File tree, tabbed WYSIWYG editor, D3 knowledge graph, and pipeline view. Dark, minimal, Inter for body text.

**2. Knowledge Graph**

> Force-directed graph of a 47-page vault built from 6 source documents. Click any node to highlight its neighborhood and dim the rest. Hubs sized by connection count.

**3. Connectors Grid**

> 38 live connectors across 9 categories — OAuth for most, API key for the rest. One dispatch pipeline behind all of them. Real-time status badges.

**4. Observer Run**

> The Observer scoring a page on coverage, consistency, cross-linking, freshness, and organization. Budget preview before any LLM call. Every run commits a structured diff.

**5. MCP + Claude Code**

> 19 MCP tools registered. Claude Code runs `wikimem_search` and `wikimem_ask` inline, reading the compiled vault directly — no copy-paste, no context-stuffing.

**6. Time-Lapse**

> Scrub through git history to watch the wiki grow: pages appear, wikilinks form, the graph densifies. Every state is a real commit.

**7. CLI Ingest**

> `wikimem ingest paper.pdf` — pipeline runs through detection, extraction, dedup, LLM compile, page generation, git commit. 6 pages created, 12 wikilinks, SHA printed.

---

## Categories to tag

- Developer Tools
- Artificial Intelligence
- Open Source
- Productivity

---

## Launch-day notes

- Best day: Tuesday or Wednesday. Avoid Monday (crowded) and Friday (dies)
- Launch at 12:01 AM PT — hunters get the full 24h slot
- First comment within 2 minutes of launching
- Reply to every comment for the first 6 hours
- Prep 10 concrete upvotes from people who will actually leave a meaningful comment — not a pleading DM broadcast
- Have the 8-second knowledge-graph GIF as the first gallery item; screenshots come after
