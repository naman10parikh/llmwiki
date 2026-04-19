# Changelog

All notable changes to wikimem are documented here.

## [0.10.0] - 2026-04-17

### Features

- **MCP OAuth 2.1 server** — wikimem is now a Claude-Connector-compatible MCP server. Paste `https://<your-host>/mcp` into Claude.ai Custom Connectors → DCR auto-registers, OAuth 2.1 + PKCE + Resource Indicators, user clicks Allow once, tools appear. New modules: `src/mcp/http-server.ts`, `src/mcp/oauth-server.ts`, `src/mcp/jwt.ts`, `src/mcp/oauth-store.ts` (~1,200 lines). Endpoints: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register` (RFC 7591), `/oauth/authorize`, `/oauth/token`, `POST /mcp` (JSON-RPC 2.0 with Bearer auth + WWW-Authenticate 401).
- **Discord sync module** — `src/core/sync/discord.ts` (380 L) using discord.js v14. Lists guilds → channels → recent messages → ingests as wiki pages with user mention resolution and attachment URLs. Closes the 38/44 hollow-shell gap so Discord is now a real connector, not just a token endpoint.
- **`wikimem init --from-folder <path>`** — walks a directory, detects file types (13 formats), ingests each through the pipeline. #1 requested onboarding feature. Supports `--max-file-size`, skips non-processable binaries with warn, prints scanned/ingested/skipped/errors summary.
- **`wikimem init --from-repo <url-or-path>`** — accept git URL (shallow clone) or local `.git` directory. Ingests README, `docs/**`, and root markdown. Generates a "Repository Overview" wiki page with file tree + languages. Supports `--include` / `--exclude` glob filters and `--keep-clone`.
- **`wikimem add-source <path>` (new command)** — incremental ingest: mtime + SHA-256 manifest at `.wikimem-manifest.json`. Only ingests NEW or CHANGED files. Prints deltas before acting.
- **KARP-003 auto-categorize** — Observer classifies pages without category frontmatter. BM25-first (cheap), LLM fallback only if confidence < 0.65. Target categories: source/entity/concept/synthesis/daily/meeting/project. Adds 0-2 pts `categoryCoverage` dimension to 24-pt score. ≤3 LLM calls/run.
- **KARP-007 wiki-wide summary** — Observer generates/refreshes `<wikiRoot>/wiki/INDEX.md` with page count, top-10 wikilinked topics, 3-sentence state-of-the-wiki summary. Skips LLM call if wiki-hash unchanged (caching). New API `GET /api/wiki-summary`.
- **KARP-010 citation scoring** — Every page's outbound URLs scored (domain quality, URL specificity, recency). Stored as `citationScore` frontmatter. Aggregate `avgCitationScore` wiki-wide. Surfaces worst-5 cites per Observer run.
- **KARP-012 semantic similarity graph edges** — BM25-based content overlap computes inter-page similarity. Edges with sim > 0.35 that have NO wikilink surface as "missing wikilink suggestions". Optional render as faint dashed edges in the D3 graph.
- **Observer Experiment History panel** — New sidebar section with SVG timeline chart, per-run hypothesis/action/result, score delta, duration, LLM calls. "Run Observer Now" button streams SSE logs in real time. THE moat: no competitor shows self-improvement transparently.
- **Typography + color token system** — Replaced 36 hardcoded font-size values + 109 random hex colors with `--font-{xs..3xl}` + `--bg-primary`, `--text-primary`, `--accent`, etc. Removed Inter-Light (weight 300) per chairman. Home hero no longer renders in thin Instrument Serif.
- **Top-right duplicate status counter removed** — statusbar now only in bottom-left.
- **Home hero wiki name** — now shows `<wikiConfig.name>'s Wiki` or `Welcome to My Wiki` fallback (not hardcoded "WikiMem").
- **Font-size appearance setting** — Now actually controls body font-size via `--font-base` binding. The slider works.

### Security

- **`/mcp` endpoint protected** — Bearer token validated (audience claim = canonical URI, scope check). 401 + WWW-Authenticate pointer to resource_metadata URL on missing/invalid token (RFC 9728).
- **OAuth code-verifier hash check** — PKCE S256 enforced at token endpoint.
- **Refresh token rotation** — old refresh token invalidated on new issuance (OAuth 2.1 §4.3.1 compliance).
- **Token audience binding** — access tokens carry `aud` claim; server rejects tokens issued for other audiences (prevents token passthrough / confused deputy).

### Bug Fixes

- **Build unblocker** — `karp-003-categorize.ts` had `await import` in non-async function. Fixed to use synchronous `writeFileSync` import at top of file.
- **Dead code removed** — `src/web/public/js/app.js` had stale CONNECTOR_CATALOG diverging from `index.html`. Deleted (was not served — only the monolith in `index.html` is used).

### Tests

- `tests/mcp-oauth.test.ts` — GET well-known metadata, POST /register, 401 flow, full E2E register → authorize → token → tools/list, scope enforcement.
- `tests/source-manifest.test.ts` — hashing, mtime, and diff-buckets (NEW/CHANGED/UNCHANGED) for `wikimem add-source` incremental ingest.
- **Total suite: 100/100 passing** (up from 87 in v0.9.0) across 9 test files.
- Integration tests for `discord-sync`, `init-from-folder`, `add-source`, `observer-karp`, `observer-experiments-api` — scheduled for v0.10.1 patch; code paths are manually verified via live `wikimem serve` smoke test.

### Documentation

- `README.md` — added "Use as a Claude Connector" section with ngrok setup walkthrough.
- `launch-drafts/` (new directory, 10 files) — X thread (9 tweets), Show HN, DEV.to article (1180 words with 4 code snippets), Product Hunt tagline + first comment + 7 gallery captions, 4 Reddit variants (r/LocalLLaMA, r/ObsidianMD, r/selfhosted, r/DataHoarder), Hacker Newsletter + IndieHackers combined, `INDEX.md` with full post schedule and quality-check notes.

### Chore

- `discord.js` ^14, `jose` ^5 dependencies added.
- `pnpm-lock.yaml` updated.

# Changelog

All notable changes to wikimem are documented here.

## [0.9.0] - 2026-04-14

### 🎉 Features

- **38/44 connectors live** — One-click connect for Notion, Linear, Jira, GitHub, Google Drive, Gmail, Slack, RSS, and more via OAuth, API key, bot token, or webhook. Full connector catalog with 9 category tabs and real-time search filter.
- **Box connector** — Developer token auth added as a P0 moat connector (`feat: Box connector via developer token`).
- **Observer v2 — Open-Endedness Engine** (+478L `observer.ts`) — 5 automated discovery functions: vault gap detection, semantic contradiction surfacing, missing page suggestions, temporal staleness scoring, and serendipitous connection proposals. Budget caps prevent runaway LLM spend.
- **7 new MCP tools** (`mcp-tools-extended.ts`) — `ingest_url`, `search`, `ask`, `run_observer`, `list_connectors`, `stats`, `lint` — full Claude Code integration for wikimem vaults.
- **Streaming query improvements** — Real-time streamed LLM responses in the web UI.
- **TLDR extraction** — Every ingested page now auto-generates a `tldr` frontmatter field via LLM pipeline.
- **Rich UI Polish wave** — Single-click inline edit (UXO-031), markdown shortcuts (UXO-032), datetime stamps (UXO-093), bookmark system (UXO-038/039), vault hierarchy in Explorer, raw file dates, recent item timestamps, time-lapse prefetch progress bar.
- **Per-area model config** — Separate LLM model selection for ingest, query, and observer pipelines.
- **Scheduler** (`scheduler.ts`) — Central automation management for sync jobs across all connectors.
- **Privacy audit module** (`privacy.ts`, +239L) — Sensitive data scanner, `.gitignore` enforcement, and vault privacy health report.
- **Sync preview mode** — Cost estimation before committing a full sync on GitHub, Gmail, Notion, RSS, Slack connectors.
- **Resource picker with sync filters** — Fine-grained control over what gets synced per connector.

### 🔒 Security

- **Server bound to `127.0.0.1` only** — Eliminated LAN exposure of `/api/auth/tokens` which previously had no authentication and was accessible on the local network.
- **`tokens.json` hardened** — `chmod 0600` on tokens file, `chmod 0700` on `.wikimem/` directory. Credentials no longer world-readable.
- **`postMessage` origin scoped** — OAuth popup messages now validate `event.origin === localhost:port` instead of wildcard `*`, preventing cross-origin token hijacking.
- **OAuth callback error sanitization** — Internal error details (file paths, stack traces) no longer leaked in OAuth callback responses.

### 🐛 Bug Fixes

- **TDZ crash on Connectors view** — `_connectorTokenStatus` was referenced at line 11818 but declared at line 19944; router fires early on `#connectors` hash causing a Temporal Dead Zone ReferenceError. Fixed by hoisting all variable declarations to top of script block.
- **`closeCxModal`/`closeObsModal` ref guard** — Modal close functions referenced before assignment during `init → loadHome` flow; guarded with existence checks to prevent startup crash.
- **Command palette `syncAllConnectors` TDZ** — Palette registered `syncAllConnectors` by reference before its definition; wrapped in arrow function to defer evaluation.
- **Intermittent 500 on `/api/status`** — Missing vault dirs caused spurious 500 responses on cold starts; added `ensureVaultDirs()` + retry + structured error logging.
- **Rate-limited partial writes** — Agent touch-up prevents partial page writes when LLM provider rate-limits mid-ingest.

### 🎨 Polish

- **Card animations and hover states** — `components.css` (+252L): focus rings, card hover lift, empty/loading state illustrations, semantic color tokens.
- **Explorer vault hierarchy** — File tree now renders nested vault folder structure instead of a flat list.
- **Connector cards** — All 44 connector cards show OAuth/connection status badges with real-time polling from `/api/auth/tokens`.

### 📚 Docs

- **`docs/value-prop-claude-code.md`** — New doc covering Claude Code integration value proposition for wikimem.
- **`LAUNCH-CONTENT.md`** — Ready-to-post launch assets for X, HN, Reddit, DEV.to, and Product Hunt.
- **`README-LAUNCH.md`** — Launch-oriented README rewrite (361L) with cleaner install story.

---

## [0.5.1] - 2026-04-08

### Fixed (E2E Audit — Ralph Loop)

- **Duplicate settings icon**: Removed settings gear from icon rail (was redundant with sidebar bottom gear). Settings now accessed only from sidebar bottom, matching Obsidian pattern.
- **Dead "New Note" button**: Wired up with prompt for title + new `POST /api/pages` endpoint. Creates page with frontmatter, refreshes tree, and opens the page.
- **Search icon active state**: Rail search icon now highlights blue when search overlay is open, de-highlights when closed.
- **Settings gear active state**: Sidebar bottom gear icon now turns blue when settings view is active.
- **Stale tree highlight**: Navigating away from page view (to home/graph/settings) now clears the active tree item highlight.
- **Stale status bar path**: Status bar right side now clears when not viewing a page.
- **Misleading empty folders**: Empty folders (0 children) now start collapsed instead of expanded, preventing visual confusion with root-level files.
- **Drop zone text**: Changed from "Drop files to add to vault" to "Drop files or click to upload".

### Verified (E2E Testing)

- File upload pipeline: `.md`, `.json`, `.csv`, `.txt`, `.yaml` all ingest correctly (tested via API and file watcher)
- File watcher (`wikimem watch`): Detects new files in raw/, auto-ingests with chokidar
- Search (Cmd+K): Fuzzy search → select → navigate to page works end-to-end
- Command palette (Cmd+P): All 8 commands visible and functional
- Settings page: General and Provider sections load config data correctly
- Graph view: 37-node force-directed graph renders with edges
- Tab management: Open/close/switch tabs works correctly
- Ask Your Knowledge: LLM query returns rendered markdown with wikilinks
- Keyboard shortcuts: Cmd+K, Cmd+P, Cmd+G, Cmd+comma, Escape all verified
- Wiki growth: 5 source files → 37 pages, 6,100 words, 251 cross-links, 0 orphans

## [0.5.0] - 2026-04-08

### Added

- **Obsidian-style icon rail**: Thin vertical strip on the extreme left with SVG icons for Files, Search, and Graph. Active icon gets blue highlight bar. Tooltips on hover.
- **Settings page**: Full two-column settings view (General, Provider, Appearance, Automations, Hotkeys, About). Accessible from sidebar gear.
- **API key configuration**: Configure Anthropic and Gemini keys from the web UI. Model selector (Claude Sonnet 4, 3.5 Sonnet, 3 Haiku). Connection test button with live feedback.
- **Settings API**: GET/PUT `/api/config` and POST `/api/config/test-provider` endpoints with API key masking.
- **Create page API**: POST `/api/pages` endpoint for creating new wiki pages from the web UI.
- **Command palette**: `Cmd+P` opens a fuzzy command palette with 8 commands (Home, Graph, Search, Settings, Sidebar, Upload, Refresh, Collapse).
- **Graph node highlighting**: Click a node to highlight it + connected neighbors. All other nodes dim to 12% opacity. Click empty space to reset. Double-click opens page.
- **Table of contents**: Auto-generated from headings (h1-h4) on pages with 3+ headings. Click to smooth-scroll.
- **URL ingestion**: "Add a URL to your vault" section on home page with validation, spinner, and success feedback.
- **Sidebar action bar**: EXPLORER header with New Note, Collapse All, and Refresh buttons.
- **Sidebar bottom bar**: Vault name/icon and settings gear button.
- **Keyboard shortcuts**: `Cmd+P` (palette), `Cmd+G` (graph), `Cmd+,` (settings), `Cmd+W` (close tab).

### Changed

- **Complete color overhaul**: Removed all purple accents. New palette: `#1e1e1e` background, `#4f9eff` blue accent (only on active states), warm neutral text hierarchy. Professional and minimal.
- **Font overhaul**: Replaced Poppins with Inter + system font stack. Instrument Serif restricted to logo/display only. JetBrains Mono for code.
- **Tab bar**: Moved to top strip with Chrome-style rounded tabs. Active tab visually connects to content. `+` button for new tab/home.
- **File tree**: Replaced emoji chevrons with SVG arrows with smooth rotation animation. Empty folders start collapsed.
- **Topbar**: Removed centered action buttons (☰⌂⊛⌕↑). Tab bar and status indicator only.
- **Inline code**: Now uses warm `#ce9178` color instead of purple.
- **Links**: Blue (`#4f9eff`) instead of purple throughout.

## [0.4.0] - 2026-04-08

### Added

- `wikimem init --from-folder <path>` — Create a wiki from any existing folder with recursive file scanning and batch ingest
- `wikimem init --from-repo <url-or-path>` — Create a wiki from a GitHub repository (clone + scan)
- `wikimem history list` — View chronological audit trail of all wiki changes
- `wikimem history restore <id>` — Restore wiki to a previous snapshot
- History tab in web UI with timeline visualization, automation type icons, and color-coded entries
- Raw file viewer — click any raw source in the dashboard to view its contents in a modal
- Auto-ingest on upload — web UI file uploads now automatically trigger the ingest pipeline
- Install script (`scripts/install.sh`) for curl one-liner installation
- Git-style audit trail system (`.wikimem/history/`) tracking every wiki change with snapshots

### Fixed

- Query tab now correctly sends POST requests (was broken with GET)
- CLI version now reads dynamically from package.json (was hardcoded to 0.1.0)
- Raw files in dashboard now clickable and browseable
- Upload results now show ingest outcome (pages created count)

### Changed

- Raw files listing now walks subdirectories recursively
- Upload endpoint stores files in date-stamped subdirectories
- Init command refactored into modular scaffold + mode-specific handlers

## [0.3.0] - 2026-04-07

### Added

- Unified naming to wikimem everywhere
- PDF extraction with pdf-parse v1
- Fixed query and ingest API endpoints

### Fixed

- PDF extraction works with real PDF files
- API endpoint consistency (query/ingest)

## [0.2.3] - 2026-04-07

### Fixed

- PDF text extraction using pdf-parse
- Query and ingest API endpoint routing

## [0.2.2] - 2026-04-07

### Fixed

- Dynamic version display from package.json
- Init command no longer adds 'cd .' for in-place init
- Removed npx prefix from help text

## [0.2.1] - 2026-04-07

### Fixed

- Markdown rendering works — built-in renderer with no CDN dependency

## [0.2.0] - 2026-04-07

### Added

- Web UI markdown rendering with clickable wikilinks
- Page detail modal with frontmatter badges

## [0.1.0] - 2026-04-07

### Added

- CLI with 10 commands: init, ingest, query, lint, status, watch, scrape, improve, duplicates, serve
- Three layers: raw/ (immutable sources), wiki/ (LLM-generated), AGENTS.md (schema)
- Three automations: ingest & process, external scrape, self-improvement via LLM Council
- 3 LLM providers: Claude (Anthropic), OpenAI, Ollama
- 9 file processors: text, URL, image (Claude Vision), audio (Whisper), video (ffmpeg), PDF, DOCX, XLSX, PPTX
- Web UI with d3 knowledge graph, dashboard, pages list, query tab, upload tab
- Obsidian-native output (.obsidian/ config, wikilinks, frontmatter, graph colors)
- BM25 full-text search with title boosting
- Semantic search with RRF (Reciprocal Rank Fusion) hybrid
- Semantic dedup with Jaccard similarity (0.7 threshold)
- Batch ingest with progress display
- Interactive tagging (--tags, --category, --interactive)
- File watcher mode (wikimem watch)
- 4 domain templates: personal, research, business, codebase
- Auto-update checker (npm registry, 24h cache)
- 58 unit tests (4 test suites)
- Published to npm as wikimem@0.1.0
