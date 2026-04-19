# Building WikiMem: A Self-Improving LLM Wiki in 10 Days

**Cover:** screen recording of the knowledge graph densifying as sources ingest. 16:9.

**Tags:** `#ai` `#opensource` `#typescript` `#claude`

**Canonical URL:** point to the GitHub README after publish.

---

On April 7, Andrej Karpathy tweeted:

> I've been using [an LLM] to build my own wiki, which is surprisingly useful. Files go in. The LLM compiles them into interlinked pages. The pages are what the LLM reads next time.

The replies piled up immediately. Everyone agreed it was the right pattern. Nobody seemed to be shipping it.

Ten days later, WikiMem is on npm. `npx wikimem` gets you a CLI, a web IDE, an MCP server for Claude Code, 38 working connectors, and a self-improving Observer that scores your vault nightly and applies fixes. MIT, 23K lines of TypeScript, 87 tests, zero console errors at launch.

This post is a technical tour: the architecture, how the Observer works, the MCP-first connector model, and the parts I'd change.

## The Karpathy Tweet

The point Karpathy made wasn't about memory APIs or vector stores. It was about *compilation* vs *retrieval*.

RAG retrieves paragraphs at query time. The answer depends on what the embedding model thought was similar. You can't browse RAG. You can't audit RAG. The shape is wrong for personal knowledge at hundreds-of-sources scale.

A wiki compiles knowledge upfront into structured pages with explicit cross-references. The output is human-readable and auditable. You see exactly what the system knows. The LLM reads the same wiki you do.

That's the whole pitch. Everything else is implementation.

## The Architecture

Three layers, one directory:

```
vault/
├── raw/               immutable source documents, date-stamped
├── wiki/              LLM-generated pages
│   ├── sources/       one summary per ingested source
│   ├── entities/      people, organizations, tools
│   ├── concepts/      ideas, frameworks, patterns
│   └── syntheses/     cross-cutting analyses
├── AGENTS.md          schema — LLM reads this before every operation
└── config.yaml        provider + connectors + schedules
```

The separation matters. `raw/` is immutable — provenance, idempotency, re-runnability. `wiki/` is generated — deletable, regeneratable, auditable. `AGENTS.md` is the schema that co-evolves with the vault; edit it and the next ingest follows the new conventions.

Three automations run over this structure:

1. **Ingest** — a chokidar watcher on `raw/` detects new files, dispatches to the right processor, runs the LLM compilation step, writes pages, and commits to git.
2. **Scrape** — a node-cron scheduler fetches RSS feeds, GitHub queries, and URLs on schedule and deposits them in `raw/`, triggering the ingest pipeline.
3. **Observe** — a nightly LLM review that scores every page and applies improvements. Details below.

## The Observer

The self-improvement loop is the piece I'm most proud of and the piece that scared me the most. A naive implementation is a money pit — "score everything every night" on a 10,000-page vault will run you thousands of dollars and still not converge.

The budget-capped version works like this:

```typescript
// src/core/observer.ts (trimmed)

interface BudgetEstimate {
  estimatedCostUsd: number;
  budgetRemaining: number;
  pagesEligible: number;
  pagesAfterCap: number;
  capped: boolean;
}

interface ObserverOptions {
  /** Max budget per run in USD (default: $2.00) */
  maxBudget?: number;
  /** Max pages to auto-improve per run (default: 3) */
  maxImprovements?: number;
  /** Max contradiction-pair comparisons per run (default: 8) */
  maxPairs?: number;
}

function estimateBudget(scores, options): BudgetEstimate {
  const maxBudget = options.maxBudget ?? 2.0;
  const maxImprovements = options.maxImprovements ?? 3;
  const eligible = scores.filter(s => s.score < threshold);
  const budgetAllowedPages = Math.floor(maxBudget / COST_PER_IMPROVEMENT);
  const effectiveMax = Math.min(maxImprovements, budgetAllowedPages, eligible.length);
  return { estimatedCostUsd: effectiveMax * COST_PER_IMPROVEMENT, /* ... */ };
}
```

Scoring happens in the vault's native format — we read each page's markdown, frontmatter, wikilink density, and freshness, and compute a 24-point score across five dimensions. That part is free.

The LLM-expensive parts are capped:

- **3 page rewrites** per run (lowest-scoring pages)
- **8 pair comparisons** for semantic contradiction detection (sampled from same-entity pages)

That's ~11 LLM calls and a $2 ceiling per run. At nightly cadence that's $60/month. For a knowledge base that maintains itself, that's fine.

Every run gets a structured commit message with scores before/after, pages touched, rationale, and budget used. The vault's git history is the experiment log.

## The Connectors

I expected building 38 connectors to take three weeks. It took four days because I followed one rule: every connector is an MCP tool, every connector dispatches through the same surface.

```typescript
// src/core/connectors.ts (pattern)

interface Connector {
  id: string;                    // "github", "slack", "notion"
  authMethod: 'oauth' | 'apikey' | 'bot_token' | 'webhook';
  listResources(token: string): Promise<Resource[]>;
  syncResource(token: string, resource: Resource): Promise<IngestPayload>;
}

// One dispatch for all 38:
async function syncConnector(id: string, token: string) {
  const connector = registry.get(id);
  const resources = await connector.listResources(token);
  for (const r of resources) {
    const payload = await connector.syncResource(token, r);
    await ingest(payload);          // same pipeline as drop-a-file
  }
}
```

The MCP server exposes `wikimem_list_connectors`, `wikimem_connect`, `wikimem_sync`, and `wikimem_preview` (cost estimate before a full sync). Claude Code can walk the list, prompt for OAuth, run a preview, and start a scheduled sync — all without you leaving the conversation.

```typescript
// src/mcp-server.ts (trimmed)

server.tool({
  name: 'wikimem_sync',
  description: 'Sync a connected source into the vault',
  inputSchema: {
    connector: z.enum(['github', 'slack', 'notion', /* ... 35 more */]),
    resourceIds: z.array(z.string()).optional(),
    dryRun: z.boolean().default(false),
  },
  handler: async ({ connector, resourceIds, dryRun }) => {
    if (dryRun) return { estimate: await estimateSyncCost(connector, resourceIds) };
    return { synced: await syncConnector(connector, { resourceIds }) };
  },
});
```

19 MCP tools total, all using the same zod-validated schema pattern. Token storage is `chmod 0600`, server bound to `127.0.0.1`, and OAuth callbacks scope `postMessage` origin checks to the running port — enough to not be embarrassing on launch day.

## The CLI

17 commands. The surface you actually use:

```bash
# Setup
wikimem init my-wiki                    # create vault + AGENTS.md + config
wikimem serve                           # web IDE on localhost:3141

# Ingest
wikimem ingest paper.pdf                # single file
wikimem ingest https://...              # URL
wikimem ingest ./research-papers/       # batch

# Query
wikimem ask "how do X and Y differ across my sources?"
wikimem search "attention mechanism"    # BM25 full-text

# Maintain
wikimem improve --dry-run               # Observer preview
wikimem improve --threshold 90          # only fix pages scoring <90
wikimem lint --fix                      # orphan/broken-link cleanup

# Integrate
wikimem mcp                             # start MCP server
```

## Lessons

**Pick a small primitive first.** The first thing that worked was `wikimem ingest paper.pdf → wiki/sources/paper.md + wiki/entities/*.md`. Everything else — connectors, Observer, MCP — is a different shape of that primitive. If the primitive is right, feature count is cheap.

**The schema file is the hidden hero.** `AGENTS.md` is a markdown file the LLM reads before every ingest. It's ~200 lines that describe frontmatter conventions, wikilink grammar, how sources differ from concepts, how to name entity pages. Changing a line in `AGENTS.md` changes every future ingest. This is a much better knob than prompt templates.

**Budget caps should be load-bearing, not a setting.** The Observer was the scariest feature to ship because a bug could spend real money. Making budget a first-class return value of every function that calls an LLM — "this op will cost $0.12, do you want to continue?" — caught three bugs before they got expensive.

**MCP is underrated for connector UX.** I was going to build a web UI for OAuth flows. Instead the MCP server exposes `wikimem_list_connectors` and `wikimem_connect`, and Claude Code walks you through auth in chat. Fewer buttons, more conversation, less UI to maintain.

**Parallel agents are real now.** Most of WikiMem was written by 22 Claude Code instances running in parallel via tmux panes — ingest pipeline in one, connectors in another, web IDE in a third, Observer in a fourth. I was mostly reviewing PRs and arbitrating conflicts. Ten days with that model is a different scale of output than ten days of me typing.

## What's next

- Semantic dedup improvements — right now it's Jaccard at 0.7, which is fine for identical-source-twice but weak for "two articles about the same thing"
- Vault sharing — a `wikimem publish` flow that turns your vault into a read-only static site with full-text search
- More write-back connectors — right now it's read-only; next is `wikimem push` to create a Notion page or GitHub issue from a wiki entry
- Evaluation harness — I want a benchmark for "does the Observer actually make this vault better over 30 days"

## Try it

```bash
npx wikimem init my-wiki
cd my-wiki
npx wikimem serve
```

GitHub: https://github.com/naman10parikh/wikimem

---

*Word count: ~1,180*

*Publishing notes: target Wednesday AM. Cross-post to personal blog with canonical URL pointing to DEV.to. Include one GIF of the knowledge graph animation above the fold.*
