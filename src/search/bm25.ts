/**
 * Simple BM25 search implementation for markdown files.
 * No external dependencies — works locally.
 */

interface Document {
  path: string;
  content: string;
  title: string;
}

interface SearchResult {
  path: string;
  score: number;
  title: string;
}

const K1 = 1.5;
const B = 0.75;

export function bm25Search(query: string, documents: Document[]): SearchResult[] {
  const queryTerms = tokenize(query);
  const avgDocLength = documents.reduce((sum, d) => sum + tokenize(d.content).length, 0) / Math.max(documents.length, 1);

  // Calculate IDF for each query term
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const docsWithTerm = documents.filter((d) =>
      tokenize(d.content).includes(term) || tokenize(d.title).includes(term),
    ).length;
    const idfValue = Math.log(
      (documents.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1,
    );
    idf.set(term, idfValue);
  }

  // Score each document
  const results: SearchResult[] = [];

  for (const doc of documents) {
    const docTerms = tokenize(doc.content + ' ' + doc.title);
    const docLength = docTerms.length;
    let score = 0;

    for (const term of queryTerms) {
      const tf = docTerms.filter((t) => t === term).length;
      const termIdf = idf.get(term) ?? 0;
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + B * (docLength / avgDocLength));
      score += termIdf * (numerator / denominator);
    }

    // Boost title matches
    const titleTerms = tokenize(doc.title);
    for (const term of queryTerms) {
      if (titleTerms.includes(term)) {
        score *= 1.5;
      }
    }

    if (score > 0) {
      results.push({ path: doc.path, score, title: doc.title });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
