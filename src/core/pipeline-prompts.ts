/**
 * Pipeline prompt defaults and user-override resolution.
 *
 * The ingest pipeline has two editable prompts for the llm-compile step:
 *  - "llm-compile-system": the system prompt sent to the LLM
 *  - "llm-compile-user":   the user-facing instruction block appended after the document
 *
 * User overrides are stored in config.yaml under pipeline.prompts:
 *   pipeline:
 *     prompts:
 *       llm-compile-system: "Custom system prompt…"
 *       llm-compile-user: "Custom instruction block…"
 */

export const PROMPT_STEP_LABELS: Record<string, string> = {
  'llm-compile-system': 'LLM Compile — System Prompt',
  'llm-compile-user': 'LLM Compile — User Instructions',
};

export const DEFAULT_PROMPTS: Record<string, string> = {
  'llm-compile-system':
    'You are a wiki maintainer. You process source documents and produce structured wiki pages in markdown with YAML frontmatter and [[wikilinks]]. Follow the schema in AGENTS.md exactly. Be concise, factual, and thorough in cross-referencing.',

  'llm-compile-user': `Process this source document and produce wiki pages. For each page, output in this exact format:

\`\`\`page
TITLE: Page Title
CATEGORY: sources | entities | concepts | syntheses
TAGS: tag1, tag2, tag3
SUMMARY: One-line summary for the index
TLDR: One or two sentences capturing the single most important thing to know about this page. Should be standalone — readable without any other context.
---
Page content in markdown with [[wikilinks]] to other pages.
\`\`\`

Produce:
1. A source summary page (in sources/)
2. Entity pages for any notable people, tools, organizations mentioned (in entities/)
3. Concept pages for key ideas or frameworks discussed (in concepts/)

Use [[wikilinks]] extensively to connect pages. Every claim should reference its source.`,
};

export type PromptStep = keyof typeof DEFAULT_PROMPTS;

export const PROMPT_STEP_IDS = Object.keys(DEFAULT_PROMPTS) as PromptStep[];

/**
 * Resolve the prompt for a given step, preferring user overrides from config.
 * @param step    The step ID (e.g. 'llm-compile-system')
 * @param overrides  The pipeline.prompts map from config.yaml (may be undefined)
 */
export function getPrompt(
  step: string,
  overrides?: Record<string, string>,
): string {
  const defaultPrompt = DEFAULT_PROMPTS[step];
  if (defaultPrompt === undefined) {
    throw new Error(`Unknown pipeline prompt step: "${step}"`);
  }
  const override = overrides?.[step];
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return defaultPrompt;
}
