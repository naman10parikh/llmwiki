---
name: wikimem
description: Self-improving LLM knowledge base. Use WHEN you need to ingest a file/URL/folder into a wiki, query your own knowledge with LLM-powered search, sync a connector (Slack/GitHub/Gmail/Discord/Notion/Linear/Jira + 30 more), run the Observer to score + improve your wiki nightly, or expose the wiki to Claude as a Custom Connector via MCP OAuth. Do NOT use for ephemeral notes, scratch work, or single-session context — WikiMem is for persistent, compounding knowledge. The harness IS the product.
---

# WikiMem — The Self-Improving Wiki Skill

## What This Skill Does

WikiMem lets Claude Code treat any directory as a **self-improving knowledge base**. It turns raw sources (files, URLs, connector data) into linted, linked, wikilinked markdown pages that compound in quality every night via an Observer loop.

**When Claude Code invokes this skill, it routes user intent to the right command:**

| User intent | Slash command |
|-------------|---------------|
| "Add this file/URL/folder to my wiki" | `/wikimem-ingest` |
| "Ask something about my saved knowledge" | `/wikimem-ask` |
| "Connect a data source (Slack, GitHub, etc.)" | `/wikimem-sync` |
| "Check vault health / stats / connector status" | `/wikimem-status` |
| "Run the self-improvement loop" | `/wikimem-improve` |

## When Claude Code Should Invoke This Skill

**DO invoke** when the user says any of these:

- "Add this to my wiki / notes / knowledge base"
- "Save this for later"
- "Remember this"
- "What did I save about X?"
- "Import my [Slack / Gmail / GitHub / Notion / folder]"
- "Organize my documents"
- "Build a knowledge graph from ___"
- "What's in my vault?"
- "Improve / clean up / lint my notes"
- "Export my wiki"
- "Ingest this URL / PDF / DOCX / audio / video"

**DO NOT invoke** for:

- One-off code questions where the user doesn't need persistence
- Ephemeral scratch work
- Pure conversation memory (use Claude Code's built-in memory instead)
- When user is just asking Claude a question that doesn't need their personal knowledge

## Prerequisites

### 1. Install WikiMem (once)

```bash
npm install -g wikimem
# or use npx without installing
npx wikimem --version
```

### 2. Initialize a vault

```bash
# Fresh empty vault
wikimem init ~/my-wiki

# From existing folder (recommended for onboarding)
wikimem init --from-folder ~/Documents/research

# From a git repo (README + docs/** + root markdown)
wikimem init --from-repo https://github.com/user/repo

# From a git URL with filters
wikimem init --from-repo https://github.com/user/repo --include "**/*.md" --exclude "**/node_modules/**"
```

### 3. Set API keys (in `~/my-wiki/.env` or shell env)

```bash
export WIKIMEM_ANTHROPIC_API_KEY=sk-...      # for LLM query + Observer
# optional
export WIKIMEM_OPENAI_API_KEY=sk-...          # fallback/alternate
```

### 4. Start the local server (for web UI)

```bash
wikimem serve --vault ~/my-wiki --port 3456
# Open http://localhost:3456
```

## The 5 Slash Commands (progressive disclosure)

### `/wikimem-ingest <source>`

Add one file, folder, or URL to the wiki. Detects type automatically:

- File → reads content → runs through pipeline (lint → extract → dedup → save as page)
- Folder → walks recursively → ingests each file through pipeline
- URL → fetches → parses HTML → ingests as page

```bash
/wikimem-ingest ~/Desktop/meeting-notes.md
/wikimem-ingest ~/Downloads/report.pdf
/wikimem-ingest https://arxiv.org/abs/2406.04244
/wikimem-ingest ~/Documents/project-folder/
```

13 supported file types: md, txt, html, pdf, docx, xlsx, csv, pptx, mp3, mp4, png, jpg, webp.

### `/wikimem-add-source <path>` (incremental — for repeat ingests)

After the first `ingest`, use `add-source` to only ingest NEW or CHANGED files. Uses mtime + sha256 manifest at `.wikimem-manifest.json`. Perfect for folders that change daily.

```bash
/wikimem-add-source ~/Downloads/   # only ingest new/changed files since last run
```

### `/wikimem-ask <question>`

LLM-powered Q&A against the wiki. Retrieves top-k pages via BM25 + optional semantic search, then asks Claude to answer with citations.

```bash
/wikimem-ask "What did I decide about the Observer budget?"
/wikimem-ask "Summarize everything I've read about open-endedness"
/wikimem-ask "List all the MCP servers I've used this month"
```

### `/wikimem-sync <provider>` (connector bridge)

Connect a live data source. 38+ connectors: github, slack, gmail, google-drive, discord, notion, linear, jira, dropbox, asana, figma, hubspot, intercom, airtable, and more.

```bash
/wikimem-sync slack      # opens Slack OAuth → select channels → ingest messages
/wikimem-sync github     # API token → select repos → ingest READMEs + docs
/wikimem-sync gmail      # OAuth → select labels → ingest emails
/wikimem-sync discord    # bot token → select guilds/channels → ingest
```

After OAuth, a **resource picker modal** opens so the user selects WHICH channels / labels / repos to sync (granular, not firehose).

### `/wikimem-status`

Vault health dashboard — pages, words, sources, wikilinks, orphans, connector status, pipeline health, latest Observer score.

```bash
/wikimem-status
```

### `/wikimem-improve` (the Observer — moat)

Runs the self-improvement loop. Observer reads the wiki, scores each page on 5 dimensions (recency, citation quality, wikilink density, category coverage, TLDR quality), identifies the weakest + newest + most-referenced pages, generates improvements (via Claude), and commits. Budget-capped at 11 LLM calls per run ≈ $0.005–$0.01.

```bash
/wikimem-improve                  # one manual run
/wikimem-improve --schedule cron  # register as a cron job (daily 3am local)
```

## The Three Automations (chairman #77 core moat)

1. **Ingestion** — `/wikimem-sync` scheduled + `/wikimem-ingest` on demand = raw sources flow in
2. **Pipeline** — detect new raw → extract → dedup → lint → save as wiki page (fully LLM-driven, editable prompts at `Settings → Automations → Pipeline`)
3. **Open-endedness / Observer** — nightly self-evolution; writes one commit per run; user can accept/reject via time-lapse restore

## Advanced — WikiMem as a Claude Custom Connector (MCP OAuth 2.1)

WikiMem exposes itself as a Claude Connector over MCP. In Claude.ai:

1. Run `wikimem serve` (or publicly reachable tunnel via ngrok)
2. Claude.ai → Settings → Custom Connectors → Add
3. Paste `https://<your-host>/mcp`
4. DCR auto-registers, OAuth 2.1 + PKCE flow, user clicks Allow once
5. Your 19+ WikiMem tools (wikimem_search, wikimem_ingest, wikimem_ask, wikimem_lint, wikimem_list_connectors, …) are now available IN Claude

**Endpoints** (RFC 9728 + 7591 compliant): `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `POST /mcp`.

## Design Tenets (preserve when working with WikiMem)

- **Professional, minimal, elegant, friendly, sleek** — per chairman directives #77 and #78
- Dark mode first (Obsidian-inspired)
- Design system at `/Users/naman/llmwiki/docs/DESIGN-SYSTEM.md`
- Typography: system-ui sans-serif for UI, no thin weights (no `font-weight: 300`), design tokens at `:root`
- One accent color throughout (`--accent`)
- Unified spacing on a 4px grid
- Source of truth is `MASTER-TODOS.md` at `/Users/naman/energy/wikimem/`

## Invocation Recipes for Claude Code

When a Claude Code user says:

> "Save this PDF to my notes"

→ Claude Code should invoke `/wikimem-ingest <pdf-path>`, report page count added, suggest `/wikimem-status`.

> "What did I read about LangGraph last month?"

→ Claude Code should invoke `/wikimem-ask "What did I read about LangGraph last month?"`, cite returned pages with wikilinks.

> "Connect my Slack"

→ Claude Code should invoke `/wikimem-sync slack`, walk user through OAuth + resource-picker.

> "Improve the wiki"

→ Claude Code should invoke `/wikimem-improve`, show SVG timeline of score delta, and offer to accept/reject the Observer commit.

## Related Resources

| Resource | Path / URL |
|----------|------------|
| Master TODOs (source of truth) | `/Users/naman/energy/wikimem/MASTER-TODOS.md` |
| WikiMem Bible (product vision) | `/Users/naman/energy/wikimem/WIKIMEM-BIBLE.md` |
| Design system | `/Users/naman/llmwiki/docs/DESIGN-SYSTEM.md` |
| Competitor UX audit | `/Users/naman/energy/wikimem/COMPETITOR-UX-2026-04-17.md` |
| Design audit | `/Users/naman/energy/wikimem/DESIGN-AUDIT-2026-04-17.md` |
| CHANGELOG | `/Users/naman/llmwiki/CHANGELOG.md` |
| npm | `https://www.npmjs.com/package/wikimem` |
| GitHub | `https://github.com/naman10parikh/wikimem` |
| Launch drafts | `/Users/naman/llmwiki/launch-drafts/` |

## Installation Flow (one-liner for new Claude Code users)

```bash
# 1. install wikimem + the 5 slash commands
npm install -g wikimem
mkdir -p ~/.claude/commands
cp -r "$(npm root -g)/wikimem/templates/claude-commands/"* ~/.claude/commands/
mkdir -p ~/.claude/skills/wikimem
cp "$(npm root -g)/wikimem/skills/wikimem/SKILL.md" ~/.claude/skills/wikimem/

# 2. init a vault
wikimem init ~/my-wiki

# 3. set API key in your shell profile
echo 'export WIKIMEM_ANTHROPIC_API_KEY="sk-..."' >> ~/.zshrc

# 4. start using it
wikimem serve --vault ~/my-wiki --port 3456 &
# In Claude Code:
/wikimem-status
```
