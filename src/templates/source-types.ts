/**
 * Source-type templates for wiki page generation.
 * Each template defines how a specific type of source should be
 * structured when compiled into wiki pages.
 *
 * Used by ingest.ts to generate appropriately structured content.
 */

export interface SourceTypeTemplate {
  id: string;
  name: string;
  description: string;
  /** Keywords that help detect this source type from content */
  detectionKeywords: string[];
  /** MIME type patterns */
  mimePatterns?: string[];
  /** System prompt addition for LLM compilation */
  systemPromptAddition: string;
  /** Suggested frontmatter fields beyond the defaults */
  extraFrontmatterFields: string[];
  /** Suggested page structure (headings) */
  suggestedStructure: string[];
}

export const SOURCE_TYPE_TEMPLATES: SourceTypeTemplate[] = [
  {
    id: 'article',
    name: 'Article / Blog Post',
    description: 'Web articles, blog posts, news pieces',
    detectionKeywords: ['article', 'blog', 'post', 'published', 'author', 'byline'],
    mimePatterns: ['text/html'],
    systemPromptAddition: `This source is a web article or blog post. Structure the wiki pages to capture:
- The core thesis or argument
- Key claims with supporting evidence
- Author's perspective and potential biases
- Practical takeaways and implications
- How this connects to other knowledge in the wiki
Use citation-style references when quoting the original.`,
    extraFrontmatterFields: ['author', 'publication', 'publish_date', 'url'],
    suggestedStructure: ['Summary', 'Key Arguments', 'Evidence & Claims', 'Implications', 'Related Concepts'],
  },
  {
    id: 'paper',
    name: 'Academic Paper / Research',
    description: 'Research papers, whitepapers, academic publications',
    detectionKeywords: ['abstract', 'methodology', 'findings', 'conclusion', 'references', 'doi', 'arxiv', 'et al'],
    mimePatterns: ['application/pdf'],
    systemPromptAddition: `This source is an academic paper or research document. Structure the wiki pages to capture:
- Abstract / TL;DR in accessible language
- Research question and hypothesis
- Methodology overview (non-technical summary)
- Key findings and results
- Limitations acknowledged by authors
- Practical implications and applications
- How this advances the field
Translate academic jargon into plain language while preserving accuracy.`,
    extraFrontmatterFields: ['authors', 'institution', 'year', 'doi', 'conference', 'citation_count'],
    suggestedStructure: ['Abstract', 'Research Question', 'Methodology', 'Key Findings', 'Limitations', 'Implications', 'References'],
  },
  {
    id: 'tweet-thread',
    name: 'Tweet Thread / Social Post',
    description: 'Twitter/X threads, social media discussions',
    detectionKeywords: ['thread', 'tweet', '🧵', '1/', 'RT', '@', 'x.com', 'twitter.com'],
    systemPromptAddition: `This source is a social media thread (likely Twitter/X). Structure the wiki pages to capture:
- The main argument condensed from the thread
- Key insights (numbered, one per point)
- Any data, links, or evidence shared
- Community reactions or counter-arguments if visible
- The author's credibility and context
Threads are informal — extract the substance while noting the conversational tone.`,
    extraFrontmatterFields: ['author_handle', 'platform', 'post_date', 'engagement'],
    suggestedStructure: ['Main Argument', 'Key Points', 'Evidence Shared', 'Context & Credibility'],
  },
  {
    id: 'podcast',
    name: 'Podcast / Audio Content',
    description: 'Podcast episodes, audio interviews, lectures',
    detectionKeywords: ['podcast', 'episode', 'interview', 'host', 'guest', 'transcript', 'listen'],
    mimePatterns: ['audio/'],
    systemPromptAddition: `This source is a podcast episode or audio content (likely transcribed). Structure the wiki pages to capture:
- Episode summary (who, what, why it matters)
- Key quotes from each speaker (attributed)
- Main topics discussed (as separate sections)
- Actionable advice or takeaways
- Disagreements or debates between speakers
- Resources/links mentioned
Attribute quotes to speakers. Separate opinion from fact.`,
    extraFrontmatterFields: ['host', 'guests', 'podcast_name', 'episode_number', 'duration', 'air_date'],
    suggestedStructure: ['Episode Overview', 'Speakers', 'Key Topics', 'Notable Quotes', 'Takeaways', 'Resources Mentioned'],
  },
  {
    id: 'video',
    name: 'Video / Lecture',
    description: 'YouTube videos, lectures, presentations, tutorials',
    detectionKeywords: ['video', 'youtube', 'lecture', 'presentation', 'tutorial', 'watch', 'timestamp'],
    mimePatterns: ['video/'],
    systemPromptAddition: `This source is a video or lecture (likely transcribed). Structure the wiki pages to capture:
- Video summary with key timestamps
- Main concepts taught or discussed
- Visual elements described (diagrams, demos, code shown)
- Step-by-step instructions if tutorial
- Speaker's key arguments
- Q&A highlights if present
Note: visual content may be lost in transcription — flag where visuals were important.`,
    extraFrontmatterFields: ['creator', 'channel', 'duration', 'publish_date', 'url', 'platform'],
    suggestedStructure: ['Overview', 'Key Concepts', 'Timestamps', 'Visual Notes', 'Takeaways'],
  },
  {
    id: 'book',
    name: 'Book / Long-form',
    description: 'Books, book chapters, long-form essays, reports',
    detectionKeywords: ['chapter', 'book', 'isbn', 'publisher', 'edition', 'foreword', 'preface'],
    systemPromptAddition: `This source is a book or long-form document. Structure the wiki pages to capture:
- Book summary (thesis, scope, intended audience)
- Chapter-by-chapter key takeaways
- Core frameworks or models introduced
- Memorable examples and case studies
- Practical applications
- Author's background and perspective
- How this connects to other books/ideas in the wiki
Create separate wiki pages for major concepts introduced by the book.`,
    extraFrontmatterFields: ['author', 'publisher', 'year', 'isbn', 'genre', 'pages'],
    suggestedStructure: ['Book Summary', 'Core Thesis', 'Key Frameworks', 'Chapter Notes', 'Practical Applications', 'Related Works'],
  },
  {
    id: 'notes',
    name: 'Raw Notes / Meeting Notes',
    description: 'Personal notes, meeting notes, brainstorms, voice memos',
    detectionKeywords: ['notes', 'meeting', 'action items', 'TODO', 'decision', 'brainstorm', 'idea'],
    systemPromptAddition: `This source is raw notes (meeting notes, personal notes, brainstorm). Structure the wiki pages to capture:
- Clean summary of what was discussed/noted
- Action items extracted (with owners if mentioned)
- Decisions made
- Open questions or unresolved items
- Key ideas worth developing further
- Connections to existing wiki topics
Raw notes are messy — your job is to extract structure and meaning. Link to existing wiki pages where concepts overlap.`,
    extraFrontmatterFields: ['meeting_date', 'participants', 'context'],
    suggestedStructure: ['Summary', 'Key Points', 'Action Items', 'Decisions', 'Open Questions', 'Related Topics'],
  },
];

/**
 * Detect source type from content and metadata.
 * Returns the best-matching template or null for generic.
 */
export function detectSourceType(
  content: string,
  filename?: string,
  mimeType?: string,
): SourceTypeTemplate | null {
  const lowerContent = content.toLowerCase().slice(0, 2000); // Only check first 2K chars
  const lowerFilename = (filename ?? '').toLowerCase();

  let bestMatch: SourceTypeTemplate | null = null;
  let bestScore = 0;

  for (const template of SOURCE_TYPE_TEMPLATES) {
    let score = 0;

    // Check keywords in content
    for (const keyword of template.detectionKeywords) {
      if (lowerContent.includes(keyword.toLowerCase())) score += 1;
    }

    // Check MIME type
    if (mimeType && template.mimePatterns) {
      for (const pattern of template.mimePatterns) {
        if (mimeType.startsWith(pattern)) score += 3;
      }
    }

    // Check filename hints
    if (lowerFilename.includes('paper') || lowerFilename.includes('arxiv')) {
      if (template.id === 'paper') score += 2;
    }
    if (lowerFilename.includes('notes') || lowerFilename.includes('meeting')) {
      if (template.id === 'notes') score += 2;
    }
    if (lowerFilename.includes('transcript') || lowerFilename.includes('podcast')) {
      if (template.id === 'podcast') score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  // Require minimum confidence (at least 2 keyword matches)
  return bestScore >= 2 ? bestMatch : null;
}

/**
 * Get the system prompt addition for a detected source type.
 */
export function getSourceTypePrompt(template: SourceTypeTemplate | null): string {
  if (!template) return '';
  return `\n\nSOURCE TYPE DETECTED: ${template.name}\n${template.systemPromptAddition}`;
}
