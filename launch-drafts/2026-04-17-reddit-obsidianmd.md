# Reddit — r/ObsidianMD

**Subreddit audience:** Obsidian power users, plugin enthusiasts, Dataview/Templater wizards. Cares about markdown purity, portability, link graphs, graph view.

---

## Title options (pick one)

1. `Obsidian-compatible vault that writes itself: drop PDFs/URLs, get structured pages with [[wikilinks]] auto-generated`
2. `WikiMem: an agent-friendly, CLI-native tool that compiles sources into an Obsidian vault — 38 connectors, MIT`
3. `Finally — a tool that turns my PDF graveyard into actual Obsidian pages with wikilinks`

Recommend #1 — leads with the Obsidian-compatible framing.

---

## Body

Not a plugin. Obsidian-adjacent tool that I thought this sub might appreciate.

WikiMem is a CLI that compiles your sources — PDFs, audio, video, URLs, Office docs, Slack/Gmail/Notion exports, 38 OAuth connectors — into a structured vault of source, entity, concept, and synthesis pages. Output is standard markdown: YAML frontmatter, `[[wikilinks]]`, `tags:` arrays. Open the folder in Obsidian and everything just works — graph view, backlinks, tags, Dataview queries on the frontmatter, all of it.

Why not write the pages myself in Obsidian: I can't keep up. I had 200+ PDFs I meant to read, hours of call recordings I never transcribed, URLs bookmarked and forgotten. Obsidian is the best tool in the world for notes you write yourself, but for sources you've accumulated, WikiMem does the compilation.

Example output from ingesting a single paper:

```
wiki/
├── sources/2026-04-14-attention-is-all-you-need.md    ← summary + citations
├── entities/vaswani-ashish.md                          ← author entity
├── entities/google-brain.md                            ← organization
├── concepts/scaled-dot-product-attention.md            ← the idea
├── concepts/transformer-architecture.md                ← the architecture
└── syntheses/...                                       ← only if >3 sources
```

All linked with `[[wikilinks]]`. Frontmatter includes `type`, `tags`, `source`, `tldr`, `created`, `updated`. Git-committed automatically.

Three automations run the vault:

1. **Ingest** — file watcher on `raw/`, drop a file, pipeline runs
2. **Scrape** — RSS feeds, GitHub queries, URLs on cron schedule → deposit in raw/ → auto-ingest
3. **Observe** — nightly LLM quality scoring (coverage, consistency, cross-linking, freshness, organization). Fixes orphan pages, flags contradictions, expands sparse entries. Budget-capped ($2/run, ~11 LLM calls).

Privacy: local-first, raw/ and config.yaml gitignored, no telemetry, Ollama mode is fully offline if you want it.

```bash
npx wikimem init my-wiki
cd my-wiki
npx wikimem serve
# then: open my-wiki/ in Obsidian
```

It's not trying to replace Obsidian — it's trying to be the compiler that feeds your vault. MIT.

GitHub: https://github.com/naman10parikh/wikimem

Happy to answer questions. Especially curious if anyone has ideas for how the Observer should handle conflicts with manually-edited pages (right now it respects a `manual: true` frontmatter flag and leaves those alone).

---

## Posting Notes

- This sub hates thinly-veiled ads. Lead with the output shape, not the pitch
- Mention what it doesn't replace (Obsidian itself) — shows respect for the community
- Include a real-world example of the generated pages structure
- No screenshots of a different app unless they render Obsidian-compatible output
