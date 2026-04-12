import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

export interface ImageResult {
  title: string;
  description: string;
  markdown: string;
  sourcePath: string;
}

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

export function isImageFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function processImage(filePath: string): Promise<ImageResult> {
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath, ext);

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
  }

  const imageData = readFileSync(filePath);
  const base64 = imageData.toString('base64');
  const mediaType = getMediaType(ext);

  // Use Claude vision to describe the image
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    // Fallback: create a basic markdown reference without AI description
    return {
      title,
      description: `Image file: ${basename(filePath)}`,
      markdown: buildMarkdown(title, filePath, `[Image file — set ANTHROPIC_API_KEY for AI description]`),
      sourcePath: filePath,
    };
  }

  const description = await describeWithVision(apiKey, base64, mediaType);

  return {
    title,
    description,
    markdown: buildMarkdown(title, filePath, description),
    sourcePath: filePath,
  };
}

async function describeWithVision(apiKey: string, base64: string, mediaType: string): Promise<string> {
  const client = new Anthropic({ apiKey });

  // Try Claude Vision — retry once on transient failures
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: base64,
                },
              },
              {
                type: 'text',
                text: `Describe this image in detail for a knowledge base. Include:
1. What the image shows (objects, people, text, diagrams, charts)
2. Key information or data visible
3. Any text content (OCR — extract ALL visible text verbatim)
4. Context and significance

Be thorough but concise. This description will represent the image in a markdown wiki where agents need to understand its content without seeing it directly.`,
              },
            ],
          },
        ],
      });

      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
    } catch (err) {
      const isRetryable =
        err instanceof Error &&
        (err.message.includes('rate_limit') ||
          err.message.includes('overloaded') ||
          err.message.includes('529') ||
          err.message.includes('timeout'));

      if (isRetryable && attempt === 0) {
        // Wait 2s and retry once
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      // Non-retryable or second failure — return fallback description
      const sizeKB = Math.round(Buffer.from(base64, 'base64').length / 1024);
      return `[Image — Claude Vision analysis failed: ${err instanceof Error ? err.message : 'unknown error'}]\n\n_File size: ${sizeKB} KB. Set ANTHROPIC_API_KEY and ensure API access to enable image description._`;
    }
  }

  return '[Image — description unavailable]';
}

function buildMarkdown(title: string, filePath: string, description: string): string {
  return `# ${title}

> **Source:** [${basename(filePath)}](${filePath})
> **Type:** Image
> **Processed:** ${new Date().toISOString().split('T')[0]}

![${title}](${filePath})

## Description

${description}
`;
}

function getMediaType(ext: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}
