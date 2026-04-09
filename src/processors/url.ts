export interface ProcessedUrl {
  title: string;
  content: string;
  url: string;
}

export async function processUrl(url: string): Promise<ProcessedUrl> {
  // Try Firecrawl first if API key is available
  const firecrawlKey = process.env['FIRECRAWL_API_KEY'];
  if (firecrawlKey) {
    return await processWithFirecrawl(url, firecrawlKey);
  }

  // Fallback: basic fetch + HTML strip
  return await processWithFetch(url);
}

async function processWithFirecrawl(url: string, apiKey: string): Promise<ProcessedUrl> {
  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { title?: string } };
  };

  if (!data.data?.markdown) {
    throw new Error(`Firecrawl returned no content for ${url}`);
  }

  return {
    title: data.data.metadata?.title ?? new URL(url).hostname,
    content: data.data.markdown,
    url,
  };
}

async function processWithFetch(url: string): Promise<ProcessedUrl> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const html = await response.text();

  // Extract title
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch?.[1] ?? new URL(url).hostname;

  // Strip HTML to get text content
  const content = stripHtml(html);

  return {
    title,
    content: `# ${title}\n\nSource: ${url}\n\n${content.substring(0, 15000)}`,
    url,
  };
}

function stripHtml(html: string): string {
  // Remove script and style elements
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}
