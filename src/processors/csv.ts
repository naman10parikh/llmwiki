/**
 * CSV (.csv, .tsv) processor.
 * Pure Node.js parser — no external dependencies.
 * Handles: quoted fields, commas in values, newlines in quotes, BOM, TSV.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface CsvResult {
  title: string;
  content: string;
  markdown: string;
  rowCount: number;
  columnCount: number;
  sourcePath: string;
}

const MAX_DISPLAY_ROWS = 100;
const MAX_DISPLAY_COLS = 10;

/** Check whether a file path looks like CSV/TSV. */
export function isCsvFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === '.csv' || ext === '.tsv';
}

/** Process a CSV or TSV file into structured output with markdown table. */
export async function processCsv(filePath: string): Promise<CsvResult> {
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath, ext);

  const raw = readFileSync(filePath, 'utf-8');
  const cleaned = stripBom(raw);

  const delimiter = ext === '.tsv' ? '\t' : detectDelimiter(cleaned);
  const rows = parseRows(cleaned, delimiter);

  if (rows.length === 0) {
    return {
      title,
      content: `[CSV — no data extracted from ${basename(filePath)}]`,
      markdown: buildMarkdown(title, filePath, '', 0, 0, []),
      rowCount: 0,
      columnCount: 0,
      sourcePath: filePath,
    };
  }

  const columnCount = Math.max(...rows.map((r) => r.length));
  const rowCount = rows.length - 1; // exclude header row
  const columnTypes = detectColumnTypes(rows);
  const tableContent = buildTable(rows, columnCount);

  return {
    title,
    content: tableContent,
    markdown: buildMarkdown(title, filePath, tableContent, rowCount, columnCount, columnTypes),
    rowCount,
    columnCount,
    sourcePath: filePath,
  };
}

// ---------------------------------------------------------------------------
// CSV parser — handles RFC 4180 (quoted fields, embedded commas/newlines)
// ---------------------------------------------------------------------------

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Sniff the most likely delimiter from the first few lines. */
function detectDelimiter(text: string): string {
  const sample = text.substring(0, 2000);
  const commas = (sample.match(/,/g) ?? []).length;
  const tabs = (sample.match(/\t/g) ?? []).length;
  const semicolons = (sample.match(/;/g) ?? []).length;
  const pipes = (sample.match(/\|/g) ?? []).length;

  const counts: Array<[string, number]> = [
    [',', commas],
    ['\t', tabs],
    [';', semicolons],
    ['|', pipes],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const best = counts[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/** Parse CSV text into a 2-D array of strings, respecting quoted fields. */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote ("")
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    // Not inside quotes
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === delimiter) {
      currentRow.push(field.trim());
      field = '';
      i++;
      continue;
    }

    if (ch === '\r') {
      // CR or CRLF
      currentRow.push(field.trim());
      field = '';
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      if (i < text.length && text[i] === '\n') i++;
      continue;
    }

    if (ch === '\n') {
      currentRow.push(field.trim());
      field = '';
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush last field/row
  if (field.length > 0 || currentRow.length > 0) {
    currentRow.push(field.trim());
    if (currentRow.some((c) => c.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Column type detection
// ---------------------------------------------------------------------------

interface ColumnType {
  name: string;
  type: 'number' | 'date' | 'boolean' | 'text';
}

function detectColumnTypes(rows: string[][]): ColumnType[] {
  if (rows.length < 2) return [];

  const headers = rows[0];
  if (!headers) return [];

  const dataRows = rows.slice(1, Math.min(rows.length, 51)); // sample up to 50 data rows

  return headers.map((header, colIdx): ColumnType => {
    const values = dataRows
      .map((row) => row[colIdx] ?? '')
      .filter((v) => v.length > 0);

    if (values.length === 0) {
      return { name: header || `col_${colIdx + 1}`, type: 'text' };
    }

    // Check number
    const numberCount = values.filter((v) => /^-?[\d,]+\.?\d*$/.test(v.replace(/,/g, ''))).length;
    if (numberCount / values.length > 0.8) {
      return { name: header || `col_${colIdx + 1}`, type: 'number' };
    }

    // Check boolean
    const boolCount = values.filter((v) =>
      ['true', 'false', 'yes', 'no', '0', '1'].includes(v.toLowerCase()),
    ).length;
    if (boolCount / values.length > 0.8) {
      return { name: header || `col_${colIdx + 1}`, type: 'boolean' };
    }

    // Check date
    const dateCount = values.filter((v) =>
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(v),
    ).length;
    if (dateCount / values.length > 0.8) {
      return { name: header || `col_${colIdx + 1}`, type: 'date' };
    }

    return { name: header || `col_${colIdx + 1}`, type: 'text' };
  });
}

// ---------------------------------------------------------------------------
// Markdown table builder
// ---------------------------------------------------------------------------

function buildTable(rows: string[][], totalCols: number): string {
  if (rows.length === 0) return '';

  const truncateCols = totalCols > MAX_DISPLAY_COLS;
  const displayCols = truncateCols ? MAX_DISPLAY_COLS : totalCols;

  const lines: string[] = [];

  for (let i = 0; i < Math.min(rows.length, MAX_DISPLAY_ROWS + 1); i++) {
    const row = rows[i];
    if (!row) continue;

    const cells: string[] = [];
    for (let j = 0; j < displayCols; j++) {
      const cell = row[j] ?? '';
      // Escape pipes and collapse newlines for table safety
      cells.push(cell.replace(/\|/g, '\\|').replace(/\n/g, ' '));
    }
    if (truncateCols) {
      cells.push('...');
    }

    lines.push(`| ${cells.join(' | ')} |`);

    // Separator after header row
    if (i === 0) {
      const sep = cells.map(() => '---');
      lines.push(`| ${sep.join(' | ')} |`);
    }
  }

  if (rows.length > MAX_DISPLAY_ROWS + 1) {
    const remaining = rows.length - MAX_DISPLAY_ROWS - 1;
    lines.push(`\n> _...and ${remaining} more rows (truncated)_`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Full markdown output
// ---------------------------------------------------------------------------

function buildMarkdown(
  title: string,
  filePath: string,
  content: string,
  rowCount: number,
  columnCount: number,
  columnTypes: ColumnType[],
): string {
  const typesSummary =
    columnTypes.length > 0
      ? columnTypes.map((c) => `\`${c.name}\` (${c.type})`).join(', ')
      : 'N/A';

  return `# ${title}

> **Source:** [${basename(filePath)}](${filePath})
> **Type:** CSV
> **Rows:** ${rowCount}
> **Columns:** ${columnCount}
> **Column types:** ${typesSummary}
> **Processed:** ${new Date().toISOString().split('T')[0]}

## Data

${content}
`;
}
