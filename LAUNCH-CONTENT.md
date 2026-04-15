# WikiMem — Launch Content

> Prepared: April 2026. Version 0.8.6.
> All copy is anti-slop: no decoration emoji, no "this changes everything", no hype.
> Model: Linear launch posts + Anthropic blog style.

---

## 1. X/Twitter Thread (6 tweets)

Post each tweet as a reply to the previous. Quote-tweet Karpathy's original on tweet 1:
https://x.com/karpathy/status/1908625766490001799

---

**Tweet 1/6 — Hook**

Every time you close your laptop, your knowledge atrophies. wikimem compiles it instead.

I took Karpathy's LLM wiki idea seriously. Built a full CLI + web IDE: 38 connectors (GitHub, Slack, Gmail, Notion, Discord — all wired), 3 live automations, a self-improving Observer that scores and repairs your knowledge base nightly.

`npx wikimem@latest`

github.com/naman10parikh/wikimem

---

**Tweet 2/6 — The Problem**

The standard answer to "give your LLM memory" is RAG: embed chunks, retrieve on query.

RAG gives you paragraphs. A wiki gives you structure.

WikiMem compiles your sources into entity pages, concept pages, and cross-references — not a vector index. The LLM reads your knowledge base the same way you do.

---

**Tweet 3/6 — Three Automations**

Set up once. Walk away.

1. **Smart Sourcing** — file watcher on raw/. Drop a file, get wiki pages + git commit.
2. **Pipeline Watcher** — RSS feeds, GitHub trending, URLs fetched on schedule → deposited → ingested automatically.
3. **Observer** — nightly LLM quality review. 24-point scoring across 5 dimensions. Fixes orphan pages. Wires broken cross-links. Flags contradictions.

All three are live and running.

---

**Tweet 4/6 — 38 Connectors**

Every connector works:

GitHub, Slack, Gmail, Notion, Discord, Google Drive, Dropbox, Airtable, Linear, Jira, Confluence, Salesforce, HubSpot, Zendesk, Intercom, Shopify, Stripe, and 20+ more.

OAuth or API key — authenticate once, sync automatically. Your knowledge base ingests from wherever your knowledge actually lives.

13+ local file formats too: PDF, audio (Whisper), video (ffmpeg), images (Vision), Office docs, URLs.

---

**Tweet 5/6 — Claude Code Integration**

If you use Claude Code, WikiMem has a native MCP server.

Add 5 lines to .mcp.json. Claude gains: wikimem_search, wikimem_read, wikimem_list, wikimem_ingest.

Every conversation can now read your compiled knowledge base directly — no copy-paste, no context-stuffing. Slash commands work too.

```bash
wikimem mcp
```

---

**Tweet 6/6 — Try It**

```
npx wikimem@latest init my-wiki
cd my-wiki
npx wikimem serve
```

Open localhost:3141. Drop a PDF. Watch it compile.

38 connectors. 3 live automations. Observer with 24-point scoring.
3 LLMs: Claude, GPT-4o, Ollama (fully local).
Obsidian-compatible output. Zero console errors. MIT licensed.

github.com/naman10parikh/wikimem
npmjs.com/package/wikimem

---

**Posting Notes**

- Best window: Tuesday–Thursday, 9–11am PT
- Media on tweet 1: GIF or screen recording of the knowledge graph building
- Hashtag on tweet 6 only: #BuildInPublic
- No asking for retweets
- Reply to every comment within 2 hours of posting

---

## 2. Hacker News Show HN Post

**Recommended title:**

> Show HN: WikiMem – Self-improving wiki that compiles PDFs, audio, and URLs into structured knowledge

(Avoid name-dropping Karpathy in the title — HN reacts better to product descriptions than celebrity references. Mention him in the body.)

---

**Body:**

Hi HN,

I built WikiMem after spending a few months frustrated with how knowledge compounds — or doesn't. I had notes scattered across Obsidian, research PDFs I'd never revisit, Slack exports I couldn't search, audio recordings from calls. The standard answer is RAG, but RAG retrieves paragraphs. I wanted a compiler: something that takes raw sources and produces structured, interlinked wiki pages I can actually browse, search, and give to an LLM as context.

WikiMem does three things:

**Ingest** (13+ formats + 38 connectors): Drop a PDF, audio file, video, spreadsheet, URL, or Slack export — or connect any of 38 OAuth/API-key sources: GitHub, Gmail, Notion, Discord, Google Drive, Airtable, Linear, Jira, and more. WikiMem detects the type, runs the right processor (pdf-parse for PDFs, ffmpeg+Whisper for video, Claude Vision for images, Firecrawl for URLs), and compiles the content into structured wiki pages — source summary, extracted entities, concept pages, and cross-references. Everything goes to `raw/` first (immutable), then to `wiki/` (LLM-generated). The original source is never modified.

**Pipeline Watcher**: Configure RSS feeds, GitHub queries, or plain URLs in `config.yaml`. WikiMem fetches them on a cron schedule and deposits the results in `raw/`, triggering the ingest pipeline automatically. Your knowledge base grows from external sources without manual intervention.

**Observer (Self-Improvement — Jeff Clune open-endedness principles)**: A nightly LLM quality review scores every wiki page on a 24-point scale across five dimensions: coverage (are all raw sources represented?), consistency (do pages contradict each other?), cross-linking (orphan pages, broken wikilinks, missing connections), freshness (are claims superseded by newer sources?), and organization (missing summaries, sparse pages). Every run is logged to the experiment log. Pages below threshold get improved automatically.

The output is plain markdown with YAML frontmatter and `[[wikilinks]]` — Obsidian-compatible from day one. Git-checkpointed automatically. Ships with an MCP server for Claude Code and Cursor, plus slash commands.

```
npx wikimem@latest init my-wiki
cd my-wiki
npx wikimem serve
```

Web IDE at localhost:3141: D3 knowledge graph, time-lapse viewer (watch the wiki grow commit-by-commit), WYSIWYG editing, Cmd+K search, pipeline visualization. Zero console errors.

Works with Claude, GPT-4o, or Ollama (fully local — no API keys, no data leaves the machine). 17 CLI commands, 15K+ lines of TypeScript, MIT licensed.

GitHub: https://github.com/naman10parikh/wikimem
npm: https://www.npmjs.com/package/wikimem

Happy to answer questions about the self-improvement cycle, the three-layer architecture (raw/wiki/AGENTS.md), how the 38 connectors work, or how it compares to vector RAG.

---

**HN Posting Notes**

- Submit URL: GitHub (more upvotes than npm links)
- Best time: Tuesday–Thursday, 8–10am ET
- Post the body above as your first comment immediately after posting
- Reply to every comment in the first 2 hours
- Do not share the HN link on other platforms (penalized)
- Expected questions and honest answers:
  - "Why not RAG?" — Wiki compiles knowledge (structured, auditable, browsable) vs RAG retrieves chunks (fragmented, context-dependent). Different use case.
  - "Why not Obsidian?" — Obsidian stores what you write. WikiMem compiles what you feed it. You don't have to write anything.
  - "Privacy?" — All local. LLM API calls are optional (Ollama mode is fully offline). raw/ is gitignored by default.
  - "How does self-improvement work?" — LLM scores pages on 5 dimensions, finds orphans and contradictions, applies targeted fixes, logs rationale. You can set a threshold and run --dry-run first.

---

## 3. Reddit r/ClaudeAI Post

**Title:** I built a native Claude Code integration for your knowledge base — 38 connectors, 3 automations, self-improving wiki

---

**Body:**

Been building with Claude Code for a while and kept running into the same problem: knowledge doesn't compound. Every new session starts fresh. You can add context via system prompts or file attachments, but there's no structured way to say "here's everything I've learned and researched — have it available in every session."

WikiMem is my solution. It's a CLI + web IDE that compiles your sources (PDFs, audio, video, URLs, Slack exports, spreadsheets — 13+ formats, plus 38 OAuth/API connectors including GitHub, Gmail, Notion, Discord, Linear, Jira, Airtable) into structured wiki pages with cross-references, entity tracking, and citations. Think less "note-taking app" and more "research compiler."

The Claude Code integration is a native MCP server plus slash commands. Add this to `.mcp.json`:

```json
{
  "mcpServers": {
    "wikimem": {
      "command": "npx",
      "args": ["-y", "wikimem", "mcp"],
      "env": { "WIKIMEM_VAULT": "/path/to/your/vault" }
    }
  }
}
```

Then Claude Code has four new tools: `wikimem_search`, `wikimem_read`, `wikimem_list`, `wikimem_ingest`. Every conversation can search your compiled knowledge directly.

The self-improvement loop is what I'm most proud of: the Observer automation (built on Jeff Clune open-endedness principles) scores your knowledge base on a 24-point scale nightly — coverage, consistency, cross-linking, freshness, organization. Orphan pages get connected. Sparse pages get expanded. Contradictions get flagged. Every run logs to an experiment log. Your wiki gets better while you're not using it.

Quick start:

```bash
npx wikimem@latest init my-wiki
cd my-wiki
npx wikimem serve
```

Open localhost:3141. Drop a PDF in the web UI or via the CLI. It processes, creates pages, and commits to git. Zero console errors.

Works with Claude, GPT-4o, or Ollama (no API keys if you go local). Obsidian-compatible output — open the folder in Obsidian, it just works.

MIT licensed. GitHub: github.com/naman10parikh/wikimem

---

**Differentiators to mention in comments if asked:**

- vs Obsidian MCP: reads raw notes, no compilation, no automation, no improvement cycle
- vs Mem0/SuperMemory: those are memory APIs, this is a structured knowledge compiler you browse and edit
- vs plain RAG: wiki is structured and browsable; RAG is opaque chunks at query time
- vs Notion AI: works on any format, not just your existing Notion content; runs the Observer improvement loop

---

## 4. DEV.to Article Outline

**Title:** Building a Self-Improving Wiki with Claude Code: 38 Connectors, Observer Scoring, and Open-Endedness

**Subtitle:** How the three-layer architecture (raw/wiki/AGENTS.md) and Jeff Clune's open-endedness principles create a knowledge compiler instead of a retrieval system

---

**Outline:**

### Introduction (200 words)

- The problem: knowledge doesn't compound across sessions
- The standard answer (RAG) and why it's insufficient for structured knowledge
- What "compiling" knowledge means vs. retrieving it
- What this article covers

### Section 1: The Core Architecture (400 words)

- Three layers: raw/ (immutable sources), wiki/ (LLM-generated), AGENTS.md (schema)
- Why immutability matters: provenance, idempotency, auditability
- The AGENTS.md co-evolution pattern: schema the LLM reads and can improve
- Code sample: what a compiled wiki page looks like (frontmatter + wikilinks + citations)

### Section 2: The Ingest Pipeline (500 words)

- File type detection
- Processor architecture (text, PDF, audio/video via Whisper, images via Vision, URLs via Firecrawl)
- The LLM compilation step: entity extraction, concept pages, cross-references
- Deduplication: content hash + Jaccard similarity (0.7 threshold)
- Git checkpointing on every change

Code: walkthrough of ingest pipeline for a research PDF

### Section 3: Three Automations (400 words)

- Automation 1: Smart Sourcing (file watcher on raw/)
- Automation 2: Pipeline Watcher (RSS/GitHub/URL cron)
- Automation 3: Observer — the self-improvement loop (Jeff Clune open-endedness principles)
  - 24-point scoring across five dimensions
  - What "improvement" means concretely (orphan linking, gap filling, contradiction flagging)
  - Experiment log: every Observer run is recorded, trends are tracked
  - Why this matters: knowledge bases decay without maintenance

### Section 4: Claude Code Integration via MCP (300 words)

- What MCP is and why it matters for ambient knowledge
- The wikimem MCP tools: search, read, list, ingest
- .mcp.json configuration
- Real workflow example: using wikimem_search in a Claude Code session

### Section 5: Design Decisions (300 words)

- Why markdown files instead of a database
- Why BM25 instead of vector search (BM25 vs vectors at 74% vs 68.5% for structured content)
- Why three layers instead of one
- Why AGENTS.md instead of hardcoded prompts

### Conclusion (150 words)

- What "self-improving" actually means in practice
- How to get started in 5 minutes
- Where the project is going (Slack/Gmail connectors, semantic dedup improvements)

---

**SEO keywords:** LLM wiki, Claude Code knowledge base, self-improving wiki, personal knowledge management, MCP server, RAG alternative, knowledge compiler

**Cross-post to:** Hashnode, personal blog

---

## 5. Product Hunt Launch Copy

### Tagline (max 60 chars)

> Self-improving wiki — 38 connectors, compiles anything

(Alternatives if too long:)
> LLM knowledge compiler — 38 connectors, Observer scoring
> The wiki that reads your sources so you don't have to

---

### Description (300 words)

WikiMem turns your raw sources into a structured, interlinked knowledge base — automatically.

Drop a PDF, audio file, video, spreadsheet, Slack export, or URL. WikiMem detects the type, extracts the content, and compiles it into structured wiki pages: source summaries, entity pages (people, organizations, tools), concept pages, and syntheses. Everything cross-referenced with `[[wikilinks]]` and committed to git.

Three automations run the system:

**Ingest** — File watcher on your raw/ folder. Drop a file, get wiki pages. Zero friction.

**Scrape** — Configure RSS feeds, GitHub queries, and URLs. WikiMem fetches them on schedule and deposits results for automatic ingestion.

**Observe** — Nightly LLM quality review. Scores coverage, consistency, and cross-linking. Connects orphan pages. Flags contradictions. Fixes sparse entries. Your wiki improves while you're not using it.

The web IDE at localhost:3141 has an interactive D3 knowledge graph, time-lapse viewer (watch your wiki grow commit-by-commit), WYSIWYG editing, Cmd+K search, and pipeline visualization.

Ships with an MCP server — add 5 lines to .mcp.json and Claude Code gains native tools to search and read your knowledge base in any conversation.

Works with Claude, GPT-4o, or Ollama (fully local, no API keys). Obsidian-compatible — open the vault folder in Obsidian and it just works.

```
npx wikimem@latest init my-wiki
cd my-wiki
npx wikimem serve
```

MIT licensed. 17 CLI commands.

---

### Gallery Captions

**Screenshot 1 — Web IDE**
> The web IDE at localhost:3141. File tree, tabbed editor, knowledge graph, and pipeline view. Dark theme, Inter font, minimal chrome.

**Screenshot 2 — Knowledge Graph**
> D3 force-directed graph of a 40-page wiki built from 5 source documents. Click a node to highlight its neighborhood. Hub nodes sized by connection count.

**Screenshot 3 — Ingest Pipeline**
> Pipeline view showing a PDF moving through type detection → text extraction → dedup check → LLM compilation → page generation → git commit.

**Screenshot 4 — Time-Lapse**
> Time-lapse scrubber. Watch pages appear, wikilinks form, and the graph densify as sources are ingested. Every state is a git commit.

**Screenshot 5 — CLI Output**
> `wikimem ingest paper.pdf` output: processor selection, page generation, cross-reference creation, git commit hash.

---

### First Comment (post immediately after launch)

Hi Product Hunt,

I built WikiMem because I kept accumulating knowledge without it compounding. PDFs I read once. Audio from calls I never transcribed. URLs I bookmarked. None of it connected.

The core insight is the difference between retrieval and compilation. RAG retrieves paragraphs at query time. A wiki compiles knowledge upfront into structured, navigable, interlinked pages that an LLM (or a human) can actually reason over.

Three things I'm most proud of:

1. **The self-improvement loop** — the Observer automation scores your wiki nightly on five dimensions and applies targeted fixes. Knowledge bases decay without active maintenance. This is the maintenance layer.

2. **The MCP server** — first-class Claude Code integration. Your compiled knowledge becomes ambient context in every session, not something you manually paste.

3. **The three-layer architecture** — raw/ (immutable sources), wiki/ (LLM-generated), AGENTS.md (schema). The schema co-evolves with the wiki. The LLM reads it before every operation. You can change the conventions and the next ingest will follow them.

Try it: `npx wikimem@latest`

GitHub: https://github.com/naman10parikh/wikimem

I'll be here all day answering questions.

---

### Key Differentiators (for tagline/description iteration)

1. Compiles, not retrieves — structured wiki vs. vector chunks
2. Self-improving — Observer automation fixes quality issues automatically
3. Claude Code native — MCP server, not a browser extension or API wrapper

---

### Social Proof

- v0.8.6 on npm
- 17 CLI commands, 13+ format processors
- Obsidian-compatible output
- Works with Claude, GPT-4o, Ollama (local)
- MIT licensed
- Built on: Karpathy's LLM wiki concept (7,882+ X posts, 40+ repos spawned in 3 days from his original post)

---

### CTAs

**Primary:** `npx wikimem@latest` — zero install, try immediately
**Secondary:** `npm install -g wikimem` — global install
**GitHub:** https://github.com/naman10parikh/wikimem
**npm:** https://www.npmjs.com/package/wikimem
