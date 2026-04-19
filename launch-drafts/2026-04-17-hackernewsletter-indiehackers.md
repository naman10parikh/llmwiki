# Hacker Newsletter + IndieHackers — Short Pitches

Two short pitches, tailored per outlet. Both under 150 words. Both self-contained.

---

## 1. Hacker Newsletter — Submission Pitch

**For:** Kale Davis's Hacker Newsletter. 50K+ devs, high-signal weekly roundup. Posts that get picked up are link + 1-2 sentence editor note.

**Submission URL:** https://hackernewsletter.com/issues (use the Submit link; or email if curator-pick route)

**Title:** WikiMem — `npx wikimem`: self-improving LLM wiki with 38 connectors

**Pitch (≤150 words):**

WikiMem is an open-source CLI and web IDE that compiles your PDFs, audio, video, URLs, and 38 OAuth-connected sources (GitHub, Slack, Gmail, Notion, Discord, Linear, Jira) into a structured wiki of entity, concept, and source pages — then a self-improving Observer scores every page on 24 points nightly and rewrites the weakest ones under a hard $2/run budget cap. Ships with a 19-tool MCP server so Claude Code and Cursor read your compiled knowledge directly. Obsidian-compatible output, local-first, works fully offline with Ollama. Built in 10 days on Karpathy's LLM wiki pattern. MIT, 23K TypeScript lines, 87 tests.

Install: `npx wikimem`. Repo: github.com/naman10parikh/wikimem.

---

## 2. IndieHackers — Community Post Pitch

**For:** IndieHackers.com — the Milestones / Started feed. Founder-authentic tone. First-person story arc, indie-positive, no VC-speak.

**Title:** Shipped WikiMem in 10 days — `npx wikimem` — self-improving LLM wiki

**Post body (≤200 words):**

On April 7, Andrej Karpathy tweeted an idea: LLMs should compile your files into a wiki instead of retrieving chunks from a vector store. The replies were unanimous — everyone wanted it. Nobody was shipping.

Ten days later, I did. WikiMem is open source on npm: `npx wikimem`.

It's a CLI plus web IDE. Drop a PDF, audio file, video, URL, spreadsheet — or connect any of 38 OAuth sources (GitHub, Slack, Gmail, Notion, Drive, Linear, Jira) — and WikiMem compiles the content into structured, cross-linked wiki pages. Nightly, an Observer scores your vault on 24 points and rewrites the weakest pages under a hard $2 budget cap. It ships with a 19-tool MCP server so Claude Code reads your vault directly.

The build itself was a demo of modern tooling: 22 Claude Code agents running in parallel in tmux panes, 23K lines of TypeScript, 87 tests. MIT. Zero VC, zero telemetry, zero subscription.

Not sure if it's a business yet. I know it's useful. Feedback welcome.

github.com/naman10parikh/wikimem

---

## Posting Notes

- Hacker Newsletter submissions are curated — one line + link is plenty. Don't stuff it
- IndieHackers rewards authenticity. The "22 agents in parallel" bit is unique + true + interesting
- Neither pitch asks for votes or upvotes
- Neither pitch uses emoji
