# `wikimem`

**Self-improving wiki IDE. Ingest anything. Query with any LLM. Three automations.**

[![npm version](https://img.shields.io/npm/v/wikimem.svg)](https://www.npmjs.com/package/wikimem)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Formats](https://img.shields.io/badge/formats-13%2B-blue.svg)](#13-format-ingestion)

```bash
npx wikimem@latest
```

## What is WikiMem?

WikiMem takes [Karpathy's LLM wiki concept](https://x.com/karpathy/status/1908625766490001799) and turns it into a full IDE. Drop any file — PDF, audio, video, slides, spreadsheet, URL — and watch it compile into structured, interlinked wiki pages via Claude, GPT-4o, or Ollama. Three automations keep your knowledge base growing and self-improving while you sleep.

```
raw/                        wiki/
  paper.pdf                   index.md ........... content catalog
  podcast.mp3    ──LLM──>    sources/paper.md ... summary + citations
  screenshot.png              entities/openai.md . people, orgs, tools
  meeting.docx                concepts/rag.md .... ideas + frameworks
  blog-url                    syntheses/ ......... cross-cutting analysis
```

## Quick Start

```bash
# Create a vault and start the IDE
npx wikimem init my-wiki
cd my-wiki
npx wikimem serve
```

Open [http://localhost:3141](http://localhost:3141). That's it — you have a running wiki IDE.

```bash
# Or ingest from the CLI
wikimem ingest paper.pdf
wikimem ingest https://en.wikipedia.org/wiki/Large_language_model
wikimem query "What are the key themes across my sources?"
```

## Features

### 13+ Format Ingestion

Drop anything. WikiMem detects the file type, runs the right processor, and produces wiki pages with cross-references and citations.

| Format | Extensions | Processor |
|--------|-----------|-----------|
| Text | `.md`, `.txt` | Direct read |
| Structured | `.json`, `.csv`, `.yaml` | Schema-aware extraction |
| PDF | `.pdf` | Built-in text extraction |
| Office | `.docx`, `.pptx`, `.xlsx` | Document parsing |
| HTML | `.html`, `.htm` | Tag stripping + content extraction |
| Image | `.png`, `.jpg`, `.gif`, `.webp` | Claude Vision description |
| Audio | `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac` | Whisper / Deepgram transcription |
| Video | `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm` | ffmpeg → Whisper transcription |
| URL | `https://...` | Firecrawl / fetch → markdown |

### Knowledge Graph

D3-powered interactive force-directed graph. Click a node to highlight its neighbors, double-click to open. Community detection clusters related pages. Hub nodes sized by connection count.

### Time-Lapse

Watch your knowledge base grow commit-by-commit. Every wiki change is checkpointed in git — scrub through the timeline to see pages appear, links form, and the graph densify.

### WYSIWYG Editing

Click any wiki page to edit it inline. Markdown shortcuts, live preview, `Cmd+S` to save. Changes are auto-committed to git.

### Three Automations

| Automation | Trigger | What it does |
|------------|---------|--------------|
| **Ingest** | File watcher on `raw/` | New file detected → process → wiki pages → git commit |
| **Scrape** | Cron schedule or manual | RSS feeds, GitHub trending, URLs → fetch → deposit in `raw/` → triggers Ingest |
| **Observe** | Nightly or manual | LLM Council scores wiki quality (coverage, consistency, cross-linking, freshness, organization) → proposes and applies improvements |

### Git Checkpointing

Every change committed automatically. Browse history, restore snapshots, see diffs. Your wiki is a git repo from day one.

### Pipeline Visualization

See exactly how your document flows through the system — file detection, text extraction, LLM processing, page generation, cross-linking, indexing — step by step in the web UI.

### Connectors

Sync external sources into your vault automatically.

| Connector | Status |
|-----------|--------|
| Local folders | ✅ Shipped |
| Git repos | ✅ Shipped |
| GitHub | ✅ Shipped |
| Webhooks | ✅ Shipped |
| Slack | 🔜 Coming soon |
| Gmail | 🔜 Coming soon |

### MCP Server

Use WikiMem as a tool inside Claude Code, Cursor, or any MCP-compatible client.

```bash
wikimem mcp
```

### Multiple LLMs

| Provider | Flag | Default Model |
|----------|------|---------------|
| Claude | `-p claude` | `claude-sonnet-4-20250514` |
| OpenAI | `-p openai` | `gpt-4o` |
| Ollama | `-p ollama` | `llama3.2` |

Ollama runs fully local — no API keys, no network, no data leaves your machine.

## CLI Reference

| Command | Description |
|---------|-------------|
| `wikimem init [dir]` | Create a new vault (`--template research\|business\|codebase`, `--from-folder`, `--from-repo`) |
| `wikimem serve` | Start the web IDE on port 3141 |
| `wikimem ingest <source>` | Process a file or URL into wiki pages |
| `wikimem search <term>` | BM25 full-text search across wiki pages |
| `wikimem ask <question>` | Ask a question, get an answer from your wiki |
| `wikimem query <question>` | Ask a question and optionally save as synthesis page (`--file`) |
| `wikimem lint` | Health-check: orphan pages, broken links, missing summaries (`--fix`) |
| `wikimem status` | Vault statistics: pages, words, sources, links, orphans |
| `wikimem watch` | Auto-ingest files dropped into `raw/` |
| `wikimem scrape` | Fetch from configured RSS/GitHub/URL sources |
| `wikimem improve` | Run self-improvement cycle (`--dry-run`, `--threshold 90`) |
| `wikimem export` | Export wiki to other formats |
| `wikimem open` | Open vault in Obsidian |
| `wikimem history` | Browse audit trail, restore snapshots |
| `wikimem mcp` | Start MCP server for Claude Code / Cursor |
| `wikimem publish` | Publish wiki as static site, RSS, JSON feed, or digest (`--format html,rss,json-feed,digest`) |
| `wikimem duplicates` | Detect and manage near-duplicate sources |

## Web UI

`wikimem serve` opens a full IDE at [localhost:3141](http://localhost:3141):

- **File tree** — browse wiki pages with collapsible folders
- **Tabbed editor** — open multiple pages, WYSIWYG markdown editing
- **Knowledge graph** — interactive D3 force-directed visualization
- **Pipeline view** — drag-and-drop file ingestion with step-by-step progress
- **Time-lapse** — scrub through git history to watch your wiki grow
- **Search** — `Cmd+K` fuzzy search across all pages
- **Command palette** — `Cmd+P` for quick actions
- **Settings** — configure API keys, models, and automations from the UI
- **Ask your knowledge** — query your wiki from the browser

## MCP Server

WikiMem ships with a built-in MCP server so Claude Code and Cursor can read, search, and query your wiki directly.

**Add to Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "wikimem": {
      "command": "npx",
      "args": ["-y", "wikimem", "mcp"],
      "env": {
        "WIKIMEM_VAULT": "/path/to/your/vault"
      }
    }
  }
}
```

**Or run standalone:**

```bash
wikimem-mcp
```

## Use as a Claude Connector (MCP OAuth 2.1)

WikiMem speaks Anthropic's Custom Connector dialect. Once `wikimem serve` is
running, any OAuth 2.1 MCP client — including Claude.ai's Custom Connector UI —
can discover, authorize, and call every wikimem tool over HTTP + JSON-RPC.

**1 · Start wikimem locally**

```bash
wikimem serve            # default: http://localhost:3141
```

**2 · Expose it with HTTPS** (Claude requires HTTPS except for `localhost`).
Easiest path is ngrok or a tunneled Cloudflare Worker:

```bash
ngrok http 3141          # copy the https URL, e.g. https://abc.ngrok.app
```

Export the public URL so metadata documents advertise it:

```bash
export WIKIMEM_PUBLIC_URL=https://abc.ngrok.app
wikimem serve            # restart
```

**3 · Paste the MCP URL into Claude**

- Go to [Claude.ai → Settings → Connectors](https://claude.ai/settings/connectors).
- Click **Add Custom Connector**.
- Paste `https://abc.ngrok.app/mcp` (or `http://localhost:3141/mcp` if you're
  testing on the same machine).
- Claude will:
  1. Fetch `/.well-known/oauth-protected-resource`
  2. Fetch `/.well-known/oauth-authorization-server`
  3. POST `/oauth/register` for a fresh `client_id`
  4. Open `/oauth/authorize` — click **Allow** once
  5. Exchange the code at `/oauth/token`
  6. Call `/mcp` with the bearer token
- All 19 wikimem tools appear in the connector panel. Ask Claude anything about
  your wiki and it will cite pages from your vault.

**Security knobs**

| Env var | Purpose |
| --- | --- |
| `WIKIMEM_PUBLIC_URL` | Canonical issuer + resource URL advertised in metadata. |
| `WIKIMEM_OAUTH_SECRET` | HS256 signing key for access tokens. Auto-generated and persisted to `.wikimem/oauth-secret` if unset. |
| `WIKIMEM_OAUTH_AUTO_APPROVE` | Set to `1` to skip the consent screen (tests + CI only). |

Everything happens locally — tokens never leave your machine and the signing
secret is stored inside your vault directory (mode `0600`).

## Configuration

After `wikimem init`, your vault contains `config.yaml`:

```yaml
provider: claude                    # claude | openai | ollama
model: claude-sonnet-4-20250514

sources:
  - name: "HN Front Page"
    type: rss
    url: "https://hnrss.org/frontpage"

  - name: "GitHub Trending TS"
    type: github
    query: "stars:>100 created:>7d language:typescript"

improvement:
  threshold: 80
  schedule: "0 3 * * *"            # 3am nightly
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API access (default provider) |
| `OPENAI_API_KEY` | OpenAI API access |
| `OLLAMA_BASE_URL` | Ollama server URL (default: `http://localhost:11434`) |
| `FIRECRAWL_API_KEY` | Enhanced URL-to-markdown (optional) |
| `DEEPGRAM_API_KEY` | Audio transcription (optional, falls back to Whisper) |

## Architecture

```
vault/
├── wiki/           ← LLM-generated pages (sources/, entities/, concepts/, syntheses/)
├── raw/            ← Immutable source documents (date-stamped subdirectories)
├── AGENTS.md       ← Schema — wiki structure + conventions
├── config.yaml     ← Configuration — provider, sources, schedules
└── index.md        ← Content catalog (auto-maintained)
```

**Three layers:** `raw/` (immutable sources) → LLM processing → `wiki/` (structured knowledge). `AGENTS.md` is the schema file that tells the LLM how to structure output — it co-evolves with your wiki.

**Three automations:** Ingest (file watcher → process → wiki pages), Scrape (RSS/GitHub/URLs → raw/), Observe (LLM Council → score → improve).

## Obsidian Integration

WikiMem vaults are Obsidian vaults. Open any wikimem directory in Obsidian — no plugins, no configuration:

- `[[wikilinks]]` rendered as backlinks
- YAML frontmatter as page metadata
- Graph view showing all connections
- Tag view from frontmatter `tags:` arrays

## Privacy

- Everything runs locally. Your wiki is a folder of markdown files.
- No data sent anywhere except LLM API calls (and those are optional with Ollama).
- `raw/` excluded from git by default — your source documents stay private.
- `config.yaml` excluded from git — API keys never committed.

| Path | Safe to commit? | Why |
|------|:-:|-----|
| `wiki/` | ✅ | LLM-generated summaries, no raw personal data |
| `AGENTS.md` | ✅ | Schema file, no personal data |
| `raw/` | ❌ | Original source files |
| `config.yaml` | ❌ | May contain API keys |

## Credits

Inspired by [Andrej Karpathy's LLM Wiki pattern](https://x.com/karpathy/status/1908625766490001799) — the idea that LLMs should compile knowledge into structured, interlinked wikis rather than just answering questions from raw chunks.

Built with [Express](https://expressjs.com/), [D3](https://d3js.org/), [simple-git](https://github.com/steveukx/git-js), and the [Claude](https://docs.anthropic.com/) / [OpenAI](https://platform.openai.com/) / [Ollama](https://ollama.com/) APIs.

## License

MIT — see [LICENSE](LICENSE).
