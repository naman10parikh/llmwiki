# Reddit — r/selfhosted

**Subreddit audience:** self-hosters, homelab runners, privacy-first, Docker-native, allergic to cloud lock-in.

---

## Title options (pick one)

1. `WikiMem: self-hosted LLM wiki compiler — runs on Ollama fully offline, ingests 13 formats, 38 connectors, MIT`
2. `Finally a self-hosted knowledge compiler that doesn't require an OpenAI subscription`
3. `Open source LLM wiki I can actually run on my homelab — Ollama-compatible, nothing leaves the box`

Recommend #1.

---

## Body

Built for my own homelab, releasing open source.

WikiMem is a CLI + web IDE that compiles your sources into a structured wiki. Runs locally. Works fully offline if you pair it with Ollama.

The local-first specifics, because this sub will care:

- **Runs on any Node 18+ machine.** No Docker required, but works in Docker if you want. `npx wikimem serve` binds to 127.0.0.1:3141 (not 0.0.0.0 — intentional, no LAN exposure by default).
- **Ollama support built in.** `--provider ollama --model llama3.2` and no LLM call ever leaves your machine. Falls back gracefully when the server is down.
- **No telemetry.** Zero analytics, zero phone-home. `grep -r "analytics\|telemetry" src/` comes back empty.
- **Vault is a plain folder of markdown.** You can rsync it, back it up with restic, stick it in Syncthing, put it on a ZFS snapshot, whatever. No database.
- **Git-checkpointed by default.** Every ingest or Observer run = a commit. Roll back any state with `git checkout`.
- **Tokens stored `chmod 0600` in `.wikimem/`.** Directory is `chmod 0700`. `.gitignore` prevents accidental commits.

What it does: drop a PDF, audio file, video, spreadsheet, URL, or connect any of 38 OAuth/API sources (GitHub, Slack, Gmail, Notion, Discord, Drive, Linear, Jira, etc.). It detects the format, runs the right processor (pdf-parse / ffmpeg / Whisper / Vision / mammoth / fetch), and compiles structured wiki pages with cross-references.

Three automations: Ingest (chokidar watcher on raw/), Scrape (node-cron fetching RSS/GitHub/URLs), Observe (nightly LLM quality review with budget cap at $2/run, ~11 LLM calls).

Obsidian-compatible output. Point Obsidian at the vault folder, it works. Or just read the markdown directly.

Stack: TypeScript, Express, D3, simple-git, chokidar, node-cron, pdf-parse, mammoth. 23K lines, 87 tests, MIT.

Quick start:

```bash
npx wikimem init /srv/wikimem/my-vault
cd /srv/wikimem/my-vault
npx wikimem serve
# Reverse-proxy with Caddy/Nginx if you want it on another port
```

Or pin a version in a systemd service / Docker container — nothing exotic.

GitHub: https://github.com/naman10parikh/wikimem
npm: https://www.npmjs.com/package/wikimem

Questions welcome. Especially if anyone wants a Dockerfile upstreamed — happy to PR-review.

---

## Posting Notes

- Lead with self-hosted specifics (binds, ports, telemetry, file structure)
- Avoid marketing language; r/selfhosted smells it from the subject line
- Offer to accept a Docker PR — shows willingness to support the community
- Do NOT mention cloud providers except in comparison (e.g., "unlike X, this doesn't...")
