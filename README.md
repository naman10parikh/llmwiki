# wikimem

[![npm version](https://img.shields.io/npm/v/wikimem.svg)](https://www.npmjs.com/package/wikimem)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](#tests)

**Build self-improving knowledge bases with LLMs.**

Drop files in. Get a structured, interlinked wiki out. It improves itself while you sleep.

```bash
npx wikimem init my-wiki
```

```
raw/                        wiki/
  2026-04-07/                 index.md ........... content catalog
    paper.pdf     ──LLM──>   sources/paper.md ... summary + citations
    podcast.mp3               entities/openai.md . people, orgs, tools
    screenshot.png            concepts/rag.md .... ideas + frameworks
    blog-url                  syntheses/ ......... cross-cutting analysis
```

wikimem processes any source (text, PDF, audio, video, images, URLs), compiles it into an interlinked markdown wiki with frontmatter and `[[wikilinks]]`, and opens directly in Obsidian.

Works with **Claude, OpenAI, or Ollama** (local). Your data stays on your machine.

Inspired by [Andrej Karpathy's LLM Wiki pattern](https://x.com/karpathy/status/1908625766490001799).

## Install

```bash
npm install -g wikimem
```

**Requirements:** Node.js >= 18 &middot; An LLM API key (or Ollama running locally)

## Quick Start

```bash
# 1. Create a vault
wikimem init my-wiki
cd my-wiki

# 2. Ingest something
wikimem ingest https://en.wikipedia.org/wiki/Large_language_model
wikimem ingest ~/Documents/research-paper.pdf

# 3. Ask questions
wikimem query "What are the key differences between RAG and compiled knowledge?"
```

That's it. Your wiki is now a folder of markdown files you can open in Obsidian, VS Code, or any text editor.

## Why wikimem?

**The problem:** You have dozens of sources &mdash; papers, podcasts, articles, screenshots, meeting recordings. They sit in folders. You forget what's in them. When you need something, you search and re-read.

**RAG approach:** Chunk documents, embed them, retrieve at query time. Lossy, opaque, and the "knowledge" lives in a vector database you can't read.

**wikimem approach:** Compile sources into structured markdown pages with summaries, cross-references, and citations. The knowledge is readable, editable, version-controlled, and improves itself over time.

| | RAG | wikimem |
|---|---|---|
| **Storage** | Vector embeddings | Plain markdown files |
| **Readable?** | No (opaque vectors) | Yes (open in any editor) |
| **Editable?** | Rebuild index | Edit any page |
| **Version control** | Difficult | `git diff` |
| **Self-improving** | No | Yes (LLM Council) |
| **Works offline** | Depends | Yes (with Ollama) |
| **Obsidian** | Plugin required | Native (`[[wikilinks]]`) |

## Features

- [x] **Multi-format ingestion** &mdash; text, PDF, audio, video, images, URLs, Office docs
- [x] **Multi-model support** &mdash; Claude, OpenAI, Ollama (local)
- [x] **Obsidian-native** &mdash; `[[wikilinks]]`, YAML frontmatter, opens directly as vault
- [x] **Semantic dedup** &mdash; rejects near-duplicate sources automatically
- [x] **BM25 search** &mdash; zero-dependency full-text search, no external services
- [x] **Auto-indexing** &mdash; `index.md` + `log.md` maintained automatically
- [x] **Watch mode** &mdash; drop files into `raw/`, auto-ingested
- [x] **Self-improvement** &mdash; LLM Council scores your wiki and fixes issues
- [x] **External scraping** &mdash; pull from RSS, GitHub, URLs on a schedule
- [x] **Health checks** &mdash; find orphan pages, broken links, missing summaries
- [x] **File-back answers** &mdash; query results saved as synthesis pages
- [x] **Schema co-evolution** &mdash; AGENTS.md evolves with your wiki
- [x] **Domain templates** &mdash; personal, research, business, codebase
- [x] **Local-first** &mdash; everything is files. No database. No cloud dependency.

## Architecture

```
┌────────────────────────────────────────────────────┐
│                    wikimem CLI                      │
│                                                    │
│  wikimem init         Create a new vault           │
│  wikimem ingest       Process source → wiki pages  │
│  wikimem query        Ask questions with citations  │
│  wikimem lint         Health-check the wiki        │
│  wikimem watch        Auto-ingest on file drop     │
│  wikimem scrape       Fetch from external sources  │
│  wikimem improve      Self-improvement cycle       │
│  wikimem status       Vault statistics             │
├──────────────────────┬─────────────────────────────┤
│   Three Layers       │   Three Automations         │
│                      │                             │
│   raw/               │   A1: Ingest & Process      │
│   (immutable)   <────│   file/URL → markdown       │
│                      │   → place in wiki/          │
│   wiki/              │                             │
│   (LLM-owned)   <────│   A2: External Scrape       │
│                      │   RSS, GitHub, web → raw/   │
│   AGENTS.md          │                             │
│   (schema)      <────│   A3: Self-Improve          │
│                      │   LLM Council → score → fix │
├──────────────────────┴─────────────────────────────┤
│                  LLM Providers                     │
│   Claude (Anthropic) · OpenAI (GPT) · Ollama      │
├────────────────────────────────────────────────────┤
│                  Processors                        │
│   Text · PDF · Audio · Video · Image · URL · HTML  │
└────────────────────────────────────────────────────┘
```

### Three Layers

1. **`raw/`** &mdash; Immutable source documents. Date-stamped subdirectories. Never modified by the LLM.
2. **`wiki/`** &mdash; LLM-generated markdown. Source summaries, entity pages, concept pages, synthesis pages. The LLM owns this entirely.
3. **`AGENTS.md`** &mdash; Schema file. Tells the LLM how the wiki is structured, what conventions to follow, how to process sources. Co-evolved by you and the LLM.

### Three Automations

- **A1: Ingest & Process** &mdash; Detects file type, runs the appropriate processor (Whisper for audio, ffmpeg+Whisper for video, Claude Vision for images, text extraction for PDF), asks the LLM to produce wiki pages with cross-references.
- **A2: External Scrape** &mdash; Fetches from RSS feeds, GitHub trending, web URLs. Deposits results in `raw/` and triggers A1 automatically.
- **A3: Self-Improve** &mdash; LLM Council evaluates wiki quality across 5 dimensions (coverage, consistency, cross-linking, freshness, organization), proposes improvements, and applies them if below a configurable threshold.

## All Commands

### `wikimem init [directory]`

Create a new vault with the standard directory structure.

```bash
wikimem init my-wiki                    # Create in my-wiki/
wikimem init .                          # Initialize current directory
wikimem init my-wiki --template research   # Use research template
wikimem init my-wiki --force            # Overwrite existing
```

Templates: `personal` (default), `research`, `business`, `codebase`

### `wikimem ingest <source>`

Process a file or URL into wiki pages.

```bash
wikimem ingest paper.pdf                # PDF → extract text → wiki pages
wikimem ingest podcast.mp3              # Audio → Whisper transcription → wiki
wikimem ingest screenshot.png           # Image → Claude Vision description → wiki
wikimem ingest lecture.mp4              # Video → ffmpeg → Whisper → wiki
wikimem ingest article.md               # Markdown → wiki pages
wikimem ingest data.json                # JSON → code block in wiki
wikimem ingest page.html                # HTML → strip tags → wiki
wikimem ingest report.docx              # Office → basic extraction → wiki
wikimem ingest https://example.com/post # URL → Firecrawl/fetch → wiki
wikimem ingest raw/2026-04-07/file.md   # Re-ingest from raw/
```

Each source is auto-detected by file type, copied to `raw/{date}/`, checked for duplicates, compiled into wiki pages by the LLM, and indexed. Use `-p` to pick a provider, `-m` for a specific model, `--verbose` for detailed output.

### `wikimem query <question>`

Ask a question and get an answer synthesized from your wiki.

```bash
wikimem query "What are the main themes across my sources?"
wikimem query "Compare approaches to knowledge management" --file
wikimem query "Who is mentioned most frequently?" -p openai
```

Use `--file` to save the answer as a synthesis page in `wiki/syntheses/`. The query engine uses BM25 search to find relevant pages, reads the top 10, and synthesizes an answer with `[[wikilink]]` citations.

### `wikimem lint`

Health-check the wiki for structural issues.

```bash
wikimem lint                  # Check for issues
wikimem lint --fix            # Auto-fix where possible
```

Checks for:
- Orphan pages (no inbound `[[wikilinks]]`)
- Broken wikilinks (links to non-existent pages)
- Pages missing frontmatter summaries
- Near-empty pages (< 10 words)

Reports a quality score out of 100.

### `wikimem watch`

Watch the `raw/` directory and auto-ingest new files.

```bash
wikimem watch                 # Watch current vault
wikimem watch -v ./my-wiki    # Watch a specific vault
```

Uses `chokidar` for reliable cross-platform file watching. Waits for writes to stabilize before ingesting (2-second debounce). Press `Ctrl+C` to stop.

### `wikimem scrape`

Fetch content from configured external sources and deposit in `raw/`.

```bash
wikimem scrape                # Run all configured sources
wikimem scrape -s "HN Top"   # Run a specific source
```

Sources are configured in `config.yaml`:

```yaml
sources:
  - name: "HN Top Stories"
    type: rss
    url: "https://hnrss.org/frontpage"

  - name: "GitHub Trending TS"
    type: github
    query: "stars:>100 created:>7d language:typescript"

  - name: "Company Blog"
    type: url
    url: "https://example.com/blog"
```

Supported source types: `rss`, `github`, `url`

### `wikimem improve`

Run the self-improvement cycle (Automation 3).

```bash
wikimem improve                   # Evaluate and improve
wikimem improve --dry-run         # Show what would change
wikimem improve --threshold 90    # Stricter quality bar
```

The improvement cycle:

1. **Score** &mdash; Evaluates 5 quality dimensions (coverage, consistency, cross-linking, freshness, organization)
2. **Decide** &mdash; If score < threshold (default 80), improvements are needed
3. **Improve** &mdash; Proposes actions: add cross-links, create missing pages, expand stubs, flag contradictions
4. **Log** &mdash; Records what changed and why in `log.md`

### `wikimem status`

Show vault statistics at a glance.

```bash
wikimem status
```

```
wikimem vault status
────────────────────────────────────
  Pages:        42
  Words:        18,340
  Sources:      15
  Wiki links:   127
  Orphan pages: 2
  Last updated: 2026-04-07
```

## Configuration

After `wikimem init`, your vault contains a `config.yaml` where you set the LLM provider, external sources, self-improvement schedule, and processing options.

See [docs/configuration.md](docs/configuration.md) for the full reference.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API access (default provider) |
| `OPENAI_API_KEY` | OpenAI API access |
| `OLLAMA_BASE_URL` | Ollama server URL (default: `http://localhost:11434`) |
| `FIRECRAWL_API_KEY` | Enhanced URL-to-markdown (optional, falls back to fetch) |
| `DEEPGRAM_API_KEY` | Audio transcription API (optional, falls back to Whisper) |

## Multi-Model Support

wikimem works with any major LLM provider. Choose at init time or per-command.

| Provider | Flag | Default Model | Env Variable |
|----------|------|---------------|-------------|
| **Claude** | `-p claude` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `-p openai` | `gpt-4o` | `OPENAI_API_KEY` |
| **Ollama** | `-p ollama` | `llama3.2` | `OLLAMA_BASE_URL` |

```bash
# Use Claude (default)
wikimem ingest paper.pdf

# Use OpenAI
wikimem ingest paper.pdf -p openai -m gpt-4o-mini

# Use Ollama (fully local, no API keys)
wikimem ingest paper.pdf -p ollama -m llama3.2
```

## Multi-Format Support

| Format | Extensions | Processor | Requirements |
|--------|-----------|-----------|-------------|
| **Text** | `.md`, `.txt`, `.csv` | Direct read | None |
| **PDF** | `.pdf` | Built-in text extraction | None |
| **Audio** | `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`, `.aac` | Whisper / Deepgram | `whisper` CLI or `DEEPGRAM_API_KEY` |
| **Video** | `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm` | ffmpeg + Whisper | `ffmpeg` + `whisper` |
| **Image** | `.jpg`, `.png`, `.gif`, `.webp` | Claude Vision | `ANTHROPIC_API_KEY` |
| **HTML** | `.html`, `.htm` | Tag stripping | None |
| **JSON** | `.json` | Code block wrapping | None |
| **Office** | `.docx`, `.pptx`, `.xlsx` | Basic extraction | None (enhanced coming) |
| **URL** | `https://...` | Firecrawl / fetch | Optional `FIRECRAWL_API_KEY` |

When a processor's requirements are not met (e.g., Whisper not installed for audio), wikimem creates a reference page noting the source file and suggests installing the missing tool. The raw file is always preserved.

## Obsidian Integration

wikimem vaults are Obsidian vaults. Open any wikimem directory in Obsidian and you get:

- **Graph view** showing all pages and their `[[wikilinks]]`
- **YAML frontmatter** rendered as page metadata
- **Backlinks** panel showing what links to each page
- **Search** across all wiki content
- **Tag view** from frontmatter `tags:` arrays

No plugins required. No configuration. Just `Open folder as vault` in Obsidian.

```
# Every wiki page has frontmatter like this:
---
title: "Attention Is All You Need"
type: source
created: "2026-04-07"
updated: "2026-04-07"
tags: [transformers, attention, nlp]
sources: ["raw/2026-04-07/attention-paper.pdf"]
summary: "Foundational transformer architecture paper introducing self-attention"
---
```

## Vault Structure

```
my-wiki/
├── AGENTS.md             # Schema — wiki structure + conventions
├── config.yaml           # Configuration — provider, sources, schedules
├── .gitignore
├── raw/                  # Immutable source archive
│   ├── 2026-04-07/
│   │   ├── paper.pdf
│   │   ├── podcast.mp3
│   │   └── blog-post.md
│   └── 2026-04-08/
│       └── meeting-notes.md
└── wiki/                 # LLM-generated knowledge base
    ├── index.md          # Auto-maintained content catalog
    ├── log.md            # Chronological operation record
    ├── sources/          # One summary per ingested source
    ├── entities/         # People, organizations, tools
    ├── concepts/         # Ideas, frameworks, patterns
    └── syntheses/        # Cross-cutting analyses, query results
```

## Privacy

**`raw/` contains your source documents — personal files, PDFs, resumes, meeting recordings.** These should never be committed to a public (or even private) git repo unless you explicitly intend to share them.

wikimem generates a `.gitignore` on `wikimem init` that excludes `raw/` by default. If you initialized a vault with an older version, add these entries manually:

```gitignore
# Raw source documents — personal files, do not commit
raw/

# Config may contain API keys
config.yaml
```

| Path | Safe to commit? | Why |
|------|-----------------|-----|
| `wiki/` | ✅ Yes | LLM-generated summaries, no raw personal data |
| `AGENTS.md` | ✅ Yes | Schema file, no personal data |
| `raw/` | ❌ No | Original source files — PDFs, audio, docs |
| `config.yaml` | ❌ No | May contain API keys |

`wikimem serve` will warn you and patch your `.gitignore` if `raw/` is not excluded.

## Tests

```bash
cd /path/to/wikimem && pnpm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## See Also

- **[agentgrid](https://github.com/naman10parikh/agentgrid)** &mdash; Manage grids of AI coding agents in tmux
- **[agentdial](https://github.com/naman10parikh/Energy)** &mdash; Universal agent identity protocol across 8 messaging channels

## Credits

Inspired by [Andrej Karpathy's LLM Wiki pattern](https://x.com/karpathy/status/1908625766490001799) &mdash; the idea that LLMs should compile knowledge into structured, interlinked wikis rather than just answering questions from raw chunks.

## License

MIT &mdash; see [LICENSE](LICENSE).
