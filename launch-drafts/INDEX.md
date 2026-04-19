# WikiMem v1.0 Launch — Draft Index

> All assets written 2026-04-17. Product: wikimem v0.9.0 → tagging v1.0.0 at launch.
> Repo: https://github.com/naman10parikh/wikimem
> Install: `npx wikimem`

---

## Drafts

| File | Purpose | Words |
|------|---------|------:|
| [`2026-04-17-x-thread.md`](./2026-04-17-x-thread.md) | X/Twitter thread — 9 tweets, media plan, char-count verified | 594 |
| [`2026-04-17-hn-show.md`](./2026-04-17-hn-show.md) | Show HN post + first comment + FAQ crib | 540 |
| [`2026-04-17-devto-article.md`](./2026-04-17-devto-article.md) | DEV.to technical article — architecture, Observer, connectors, code snippets, lessons | 1,440 |
| [`2026-04-17-product-hunt.md`](./2026-04-17-product-hunt.md) | Product Hunt — tagline, description, first comment, 7 gallery captions | 606 |
| [`2026-04-17-reddit-localllama.md`](./2026-04-17-reddit-localllama.md) | r/LocalLLaMA — technical / offline-Ollama angle | 471 |
| [`2026-04-17-reddit-obsidianmd.md`](./2026-04-17-reddit-obsidianmd.md) | r/ObsidianMD — Obsidian-compatible / CLI-native angle | 470 |
| [`2026-04-17-reddit-selfhosted.md`](./2026-04-17-reddit-selfhosted.md) | r/selfhosted — privacy / local-first angle | 466 |
| [`2026-04-17-reddit-datahoarder.md`](./2026-04-17-reddit-datahoarder.md) | r/DataHoarder — archive-scale angle | 453 |
| [`2026-04-17-hackernewsletter-indiehackers.md`](./2026-04-17-hackernewsletter-indiehackers.md) | Hacker Newsletter submission + IndieHackers post | 437 |

**Total: 9 assets, ~5,477 words of drafted launch content.**

---

## Suggested Post Schedule

Week of 2026-04-20 (Mon → Fri). One channel per day so each post owns its attention window. HN gets its own standalone slot — NEVER cross-post the HN link elsewhere while it's live (HN shadow-penalizes amplification).

| Day | Time (PT) | Channel | Why this slot |
|-----|-----------|---------|---------------|
| **Mon Apr 20** | 9:00 AM | **X thread** | Kicks off the week, builds buzz before Show HN. Quote-tweets Karpathy for organic reach. |
| **Tue Apr 21** | 10:00 AM | **Show HN** | Tue-Thu 8-11am ET is the golden window. Do NOT post the X thread again today. |
| **Tue Apr 21** | 12:00 PM | **Product Hunt** | Launch at 12:01am PT ideally; if same-day as HN, PH takes the lunch slot once HN has settled into #1/#2 comments. |
| **Wed Apr 22** | 9:00 AM | **DEV.to article** | Long-form technical piece. Wednesday AM = best DEV.to traffic. |
| **Wed Apr 22** | 2:00 PM | **r/LocalLLaMA** | Mid-afternoon PT = morning traffic in EU, evening in US East. |
| **Thu Apr 23** | 10:00 AM | **r/ObsidianMD + r/selfhosted** | Post to both within 30 min. Different audiences, no overlap complaints. |
| **Thu Apr 23** | 3:00 PM | **r/DataHoarder** | Lower-traffic sub, stretches the weekly attention window. |
| **Fri Apr 24** | 9:00 AM | **IndieHackers post** | Founder-audience, end-of-week reflection tone fits. |
| **Fri Apr 24** | 9:00 AM | **Hacker Newsletter submission** | Submit Friday for the Sunday edition curation window. |

### Daily rhythm

Each launch day follows the same pattern:

1. **T-15 min:** verify `npx wikimem@latest` works cleanly on a fresh machine
2. **T-0:** post
3. **T+5 min:** paste first-comment / body / HN first comment
4. **T+0 to T+2h:** reply to every comment, ideally <15 min latency
5. **T+4h:** second-wave replies, share 1-2 screenshots if asked
6. **T+24h:** post-mortem — what worked, what didn't, update drafts for future launches

### Don't

- Do **not** broadcast the HN URL on X, Reddit, or newsletters
- Do **not** reply with identical copy across platforms — tailor every reply
- Do **not** post more than one channel per day (splits attention and upvote momentum)
- Do **not** add emoji outside the one tactical ↓ in the X thread
- Do **not** tag Karpathy unless replying to his engagement first

### Do

- Do quote-tweet Karpathy's April 7 post on the opening X tweet
- Do keep `npx wikimem` install line in every asset — install friction is zero, make it trivial
- Do mention one concrete number per asset (38 connectors / 19 MCP tools / 87 tests / $2 budget cap / 10 days / 22 agents / 23K lines)
- Do reply to negative comments with curiosity, not defense
- Do screenshot the knowledge graph as the hero visual on every channel that supports media

---

## Quality Checks Run Against Every Draft

- ✅ Contains at least one concrete number (38/19/87/23K/≤11/10/22)
- ✅ No emoji floods (X thread has 1 tactical ↓; zero elsewhere)
- ✅ Benefit → proof pattern (not feature-dump)
- ✅ Install line visible
- ✅ Repo URL visible
- ✅ MIT / open-source visible
- ✅ No purple-prose AI phrasing ("in today's fast-paced world...", etc.)
- ✅ No fake urgency
- ✅ Tailored voice per platform — HN is technical, PH is hunter-warm, Reddit is sub-specific, DEV.to is long-form technical, X is punchy, IndieHackers is founder-story

---

## Launch-Day Quick Reference

**Install (paste this anywhere):**

```bash
npx wikimem init my-wiki
cd my-wiki
npx wikimem serve
# → http://localhost:3141
```

**One-line pitch (any context):**

> WikiMem compiles your PDFs, audio, URLs, and 38 OAuth-connected sources into a structured wiki — then a self-improving Observer scores quality nightly and fixes the worst pages under a $2 budget cap. 19 MCP tools for Claude Code. MIT. `npx wikimem`.

**Key numbers:**

- 38 / 44 connectors live
- 19 MCP tools
- 87 tests
- 23K lines of TypeScript
- 13+ file formats
- 3 LLM providers (Claude / GPT-4o / Ollama)
- 10 days from Karpathy's tweet to ship
- 22 parallel Claude Code agents in the build swarm
- ≤11 LLM calls per Observer run, $2 cap
- 24-point quality scoring across 5 dimensions

**Karpathy's original tweet (quote this on X thread tweet 1):**

https://x.com/karpathy/status/1908625766490001799
