# Reddit — r/LocalLLaMA

**Subreddit audience:** technical, local-inference-first, suspicious of cloud-only tools, cares about model choice and offline mode.

---

## Title options (pick one)

1. `WikiMem: a self-improving LLM wiki that runs fully on Ollama (or Claude / GPT-4o) — 38 connectors, 19 MCP tools, MIT`
2. `I built a local-first LLM wiki: compile PDFs/URLs/Slack/Notion into a structured vault, Ollama works offline`
3. `Wiki > RAG for personal knowledge — shipping an open source compiler that runs on your local model (Ollama)`

Recommend #1 — keywords Ollama, MCP, MIT up front.

---

## Body

Posting because r/LocalLLaMA is probably the subreddit that gets the shape of this right.

WikiMem is an open source CLI + web IDE that compiles your sources — PDFs, audio (Whisper), video (ffmpeg), images (Vision), Office docs, URLs, and 38 OAuth connectors like Slack/Gmail/Notion/GitHub — into a structured wiki of source, entity, concept, and synthesis pages with wikilinks and YAML frontmatter.

The local-first bits, because this sub:

- **3 provider backends**: Claude, GPT-4o, or **Ollama**. Ollama mode is fully offline — no API keys, no network calls, nothing leaves your machine. `wikimem init --provider ollama --model llama3.2` and you're done.
- **Output is plain markdown + [[wikilinks]] + YAML frontmatter**. Open the vault folder in Obsidian, it works.
- **`raw/` is gitignored by default**. `config.yaml` (API keys if any) is gitignored by default.
- **Server binds to 127.0.0.1 only**, tokens chmod 0600. Not accessible on your LAN.

Why not plain RAG: RAG retrieves paragraphs at query time. The answer shape depends on whatever the embedding model thought was similar. For personal knowledge at hundreds-of-sources scale, I wanted structure you can actually read.

The self-improving part: a nightly Observer scores every page on 24 points across five dimensions (coverage, consistency, cross-linking, freshness, organization), then rewrites the lowest-scoring pages. Hard budget cap — max 3 rewrites and 8 contradiction-pair comparisons per run, ~11 LLM calls, $2 ceiling. At nightly cadence that's $60/mo worst case on Claude Sonnet, or $0 on Ollama.

The Claude Code / Cursor integration: 19 MCP tools including `wikimem_search`, `wikimem_read`, `wikimem_ask`, `wikimem_run_observer`, `wikimem_sync`. Five lines in `.mcp.json`.

Stack: TypeScript, 23K lines, 87 tests. Built in 10 days from Karpathy's original post on April 7. MIT.

```bash
npx wikimem init my-wiki
cd my-wiki
npx wikimem serve
```

GitHub: https://github.com/naman10parikh/wikimem

Happy to go deep on the Ollama integration, the dedup strategy (content hash + Jaccard), the AGENTS.md schema pattern, or anything else.

---

## Posting Notes

- Include the `npx wikimem` one-liner in the body, not just a link
- Be direct about offline mode — r/LocalLLaMA reads launch posts with suspicion of cloud-first
- No self-promotional closer. No "please upvote"
- Expect pushback on: "why not use llama-index?" — answer: llama-index is a framework, WikiMem is a product with an IDE and an opinion about structure
