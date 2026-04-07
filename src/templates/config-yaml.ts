export function getDefaultConfig(template: string): string {
  return `# wikimem configuration
# Docs: https://github.com/naman10parikh/llmwiki

# LLM Provider
provider: claude          # claude | openai | ollama
model: ~                  # Leave empty for provider default
# api_key: ~              # Set via ANTHROPIC_API_KEY or OPENAI_API_KEY env var

# Embeddings (for semantic search)
embeddings:
  provider: auto            # gemini | openai | local | auto (auto-detect from env)
  # model: ~                # Leave empty for provider default
  # GOOGLE_API_KEY env var for Gemini, OPENAI_API_KEY for OpenAI
  # 'local' works offline with zero deps (hash-based, lower quality)

# Vault Settings
vault:
  name: "My ${capitalize(template)} Wiki"
  template: ${template}   # personal | research | business | codebase

# Automation 2: External Source Scraping
# Configure sources to scrape on schedule
sources: []
# Example:
# sources:
#   - name: "HN Top Stories"
#     type: rss
#     url: "https://hnrss.org/frontpage"
#     schedule: "0 8 * * *"       # Daily at 8am
#
#   - name: "GitHub Trending"
#     type: github
#     query: "stars:>100 created:>7d language:typescript"
#     schedule: "0 12 * * MON"    # Weekly on Monday
#
#   - name: "Blog Feed"
#     type: rss
#     url: "https://example.com/feed.xml"
#     schedule: "0 */6 * * *"     # Every 6 hours

# Automation 3: Self-Improvement
improve:
  enabled: true
  schedule: "0 3 * * *"          # Daily at 3am
  threshold: 80                   # Score threshold (0-100)
  # Set to false to require manual approval before changes
  auto_apply: false

# Search
search:
  engine: bm25                   # bm25 | semantic | hybrid
  # bm25: keyword search (built-in, no API needed)
  # semantic: embedding-based similarity (requires embeddings config)
  # hybrid: combines bm25 + semantic via reciprocal rank fusion

# Processing
processing:
  # Audio transcription (requires Whisper or Deepgram)
  audio:
    enabled: false
    provider: whisper            # whisper (local) | deepgram (API)
    # deepgram_api_key: ~

  # Image description (requires vision-capable model)
  image:
    enabled: false

  # PDF extraction
  pdf:
    enabled: true

  # Video processing (requires ffmpeg)
  video:
    enabled: false
`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
