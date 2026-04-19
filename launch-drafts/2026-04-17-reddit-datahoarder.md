# Reddit — r/DataHoarder

**Subreddit audience:** people with terabytes of files they'll never read, archive-first, deeply suspicious of SaaS, love tools that work on folders of files.

---

## Title options (pick one)

1. `For the folder full of PDFs you'll never read: WikiMem compiles them into a searchable, linked wiki`
2. `Self-hosted LLM wiki compiler — finally a use for the 2TB of research PDFs I'll never open`
3. `WikiMem: point it at a folder, get a browsable wiki with entity pages and cross-references. Local, MIT.`

Recommend #1 — it's the most r/DataHoarder-native framing.

---

## Body

Not a hoarder for hoarding's sake — I actually wanted to use the PDFs, audio, and videos I'd been sitting on. The solution ended up being open source. Posting it here because this sub is the demographic.

WikiMem is a CLI that takes a folder of files (or 38 different OAuth-connected sources) and compiles them into a structured wiki:

- `wiki/sources/` — one summary page per ingested file
- `wiki/entities/` — people, organizations, tools mentioned
- `wiki/concepts/` — ideas and frameworks
- `wiki/syntheses/` — cross-cutting analyses (auto-generated when 3+ sources cover a topic)

All linked with `[[wikilinks]]` and committed to git.

Formats handled:

- Text (md, txt)
- Structured (json, csv, yaml)
- Office (docx, pptx, xlsx)
- PDFs (pdf-parse)
- HTML
- Images (Vision model → description)
- Audio (mp3/wav/m4a/ogg/flac → Whisper)
- Video (mp4/mov/avi/mkv/webm → ffmpeg → Whisper)
- URLs (fetch or Firecrawl)

Point it at your archive:

```bash
npx wikimem init my-archive-wiki
wikimem ingest /mnt/storage/pdf-archive/   # batch, walks recursively
wikimem ingest /mnt/storage/audio/
wikimem ingest /mnt/storage/screenshots/
```

Nightly self-improvement: the Observer scores pages and rewrites the worst ones. Budget-capped at $2/run and ~11 LLM calls — not a pipe that drains your wallet. Works with Claude, GPT-4o, or **Ollama (fully offline, no API keys)**.

Local-first specifics:

- Server binds to 127.0.0.1 only
- Vault is plain markdown — rsync, restic, ZFS snapshots, Syncthing, whatever
- `raw/` gitignored by default, your original files stay private
- No telemetry, no phone-home

Stack: TypeScript, 23K lines, 87 tests, MIT. Built in 10 days.

```bash
npx wikimem init my-wiki
cd my-wiki
npx wikimem serve
```

GitHub: https://github.com/naman10parikh/wikimem

Questions welcome — especially if anyone has an archive larger than 100GB they'd like to throw at it. I've tested up to ~2,000 files / 8GB and the pipeline is stable, but real-world archive-scale testing is where edge cases come out.

---

## Posting Notes

- Lead with "folder of files" framing — that's what this sub relates to
- Mention rsync/restic/Syncthing/ZFS — proves it plays well with existing tooling
- Invite archive-scale testing — shows humility and invites engagement
- Do NOT oversell — DataHoarder eats hype for breakfast
