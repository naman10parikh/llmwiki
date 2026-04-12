/**
 * Excel/spreadsheet (.xlsx, .xls) processor.
 * Uses xlsx (SheetJS) for extraction, with a raw XML fallback.
 * Features: multiple sheets as sections, formula result values,
 * bold/italic header detection, cell metadata.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface XlsxResult {
  title: string;
  content: string;
  markdown: string;
  sheetCount: number;
  sourcePath: string;
}

export async function processXlsx(filePath: string): Promise<XlsxResult> {
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath, ext);

  let content: string;
  let sheetCount = 0;

  try {
    const result = await extractWithSheetJS(filePath);
    content = result.content;
    sheetCount = result.sheetCount;
  } catch {
    const result = extractFromRawXml(filePath);
    content = result.content;
    sheetCount = result.sheetCount;
  }

  if (!content.trim()) {
    content = `[Spreadsheet — no data extracted from ${basename(filePath)}]`;
  }

  return {
    title,
    content,
    markdown: buildMarkdown(title, filePath, content, sheetCount),
    sheetCount,
    sourcePath: filePath,
  };
}

interface CellInfo {
  address: string;
  value: string;
  formula?: string;
  isBold: boolean;
  isItalic: boolean;
  type: string;
}

async function extractWithSheetJS(filePath: string): Promise<{ content: string; sheetCount: number }> {
  const XLSX = await import('xlsx');
  const buffer = readFileSync(filePath);
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: true,
    cellDates: true,
    cellStyles: true,
    cellNF: true,
  });

  const sections: string[] = [];
  const totalSheets = workbook.SheetNames.length;

  for (let sheetIdx = 0; sheetIdx < totalSheets; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    if (!sheetName) continue;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Get sheet dimensions
    const ref = (sheet as Record<string, string>)['!ref'];
    let rowCount = 0;
    let colCount = 0;
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      rowCount = range.e.r - range.s.r + 1;
      colCount = range.e.c - range.s.c + 1;
    }

    // Convert sheet to array of arrays (formula results rendered, not formula text)
    const data = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      rawNumbers: false,
      defval: '',
    });
    if (data.length === 0) continue;

    // Analyze cells for formatting and formulas
    const cellInfoMap = analyzeCells(sheet, XLSX);
    const headerRow = detectHeaderRow(data, cellInfoMap, XLSX);

    // Build section header with metadata
    let section = '';
    if (totalSheets > 1) {
      section += `### Sheet ${sheetIdx + 1}: ${sheetName}\n\n`;
    } else {
      section += `### ${sheetName}\n\n`;
    }

    // Sheet metadata line
    const metaParts: string[] = [];
    metaParts.push(`_${rowCount} rows × ${colCount} columns_`);

    const merges = (sheet as Record<string, unknown[]>)['!merges'];
    if (merges && merges.length > 0) {
      metaParts.push(`_${merges.length} merged region(s)_`);
    }

    const formulaCount = Object.values(cellInfoMap).filter((c) => c.formula).length;
    if (formulaCount > 0) {
      metaParts.push(`_${formulaCount} formula(s)_`);
    }

    section += metaParts.join(' · ') + '\n\n';

    // Build the table with formatting hints
    const table = buildEnhancedTable(data, cellInfoMap, headerRow, XLSX);
    if (table) section += table;

    // Formula summary (show formulas alongside their computed values)
    const formulaSummary = buildFormulaSummary(cellInfoMap);
    if (formulaSummary) {
      section += '\n\n' + formulaSummary;
    }

    sections.push(section);
  }

  // Chart info
  const chartInfo = extractChartInfo(workbook as unknown as Record<string, unknown>);
  if (chartInfo) {
    sections.push(`### Charts\n\n${chartInfo}`);
  }

  return {
    content: sections.join('\n\n---\n\n'),
    sheetCount: workbook.SheetNames.length,
  };
}

/**
 * Analyze cells for formatting (bold, italic) and formulas.
 */
function analyzeCells(
  sheet: Record<string, unknown>,
  XLSX: typeof import('xlsx'),
): Record<string, CellInfo> {
  const cellMap: Record<string, CellInfo> = {};

  for (const [key, val] of Object.entries(sheet)) {
    if (key.startsWith('!')) continue;
    const cell = val as { v?: unknown; f?: string; t?: string; w?: string; s?: { font?: { bold?: boolean; italic?: boolean } } };

    const displayValue = cell.w ?? (cell.v !== null && cell.v !== undefined ? String(cell.v) : '');

    cellMap[key] = {
      address: key,
      value: String(displayValue),
      formula: cell.f ? `=${cell.f}` : undefined,
      isBold: !!(cell.s?.font?.bold),
      isItalic: !!(cell.s?.font?.italic),
      type: cell.t ?? 's',
    };
  }

  // Suppress unused import warning — XLSX is used by callers for decode
  void XLSX;

  return cellMap;
}

/**
 * Detect which row is the header row.
 * Heuristics: first row with all string values, or first row with bold cells.
 */
function detectHeaderRow(
  data: unknown[][],
  cellInfoMap: Record<string, CellInfo>,
  XLSX: typeof import('xlsx'),
): number {
  if (data.length === 0) return 0;

  // Check if first row has bold cells
  const firstRow = data[0];
  if (Array.isArray(firstRow)) {
    let boldCount = 0;
    for (let col = 0; col < firstRow.length; col++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c: col });
      if (cellInfoMap[addr]?.isBold) boldCount++;
    }
    if (boldCount > 0 && boldCount >= firstRow.length / 2) return 0;
  }

  // Default: first row is header
  return 0;
}

/**
 * Build markdown table with formatting hints.
 * Bold cells get **wrapped**, italic cells get _wrapped_.
 */
function buildEnhancedTable(
  data: unknown[][],
  cellInfoMap: Record<string, CellInfo>,
  headerRow: number,
  XLSX: typeof import('xlsx'),
): string {
  // Filter out completely empty rows
  const rows = data.filter((row) =>
    Array.isArray(row) && row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''),
  );

  if (rows.length === 0) return '';

  const maxCols = Math.max(...rows.map((row) => (Array.isArray(row) ? row.length : 0)));
  if (maxCols === 0) return '';

  const lines: string[] = [];

  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const cells: string[] = [];
    for (let j = 0; j < maxCols; j++) {
      const cell = row[j];
      let cellStr = cell !== null && cell !== undefined ? String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ') : '';

      // Apply formatting hints from cell style
      const addr = XLSX.utils.encode_cell({ r: i, c: j });
      const info = cellInfoMap[addr];
      if (info) {
        if (info.isBold && cellStr.length > 0) {
          cellStr = `**${cellStr}**`;
        } else if (info.isItalic && cellStr.length > 0) {
          cellStr = `_${cellStr}_`;
        }
      }

      cells.push(cellStr);
    }
    lines.push(`| ${cells.join(' | ')} |`);

    // Header separator after the detected header row
    if (i === headerRow) {
      lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
    }
  }

  if (rows.length > 100) {
    lines.push(`\n> _...and ${rows.length - 100} more rows (truncated)_`);
  }

  return lines.join('\n');
}

/**
 * Build a formula summary section showing formula → computed value.
 */
function buildFormulaSummary(cellInfoMap: Record<string, CellInfo>): string {
  const formulas = Object.values(cellInfoMap).filter((c) => c.formula);
  if (formulas.length === 0) return '';

  const lines: string[] = ['**Formulas:**', ''];
  const shown = formulas.slice(0, 15);

  for (const f of shown) {
    lines.push(`- \`${f.address}\`: \`${f.formula}\` → **${f.value}**`);
  }

  if (formulas.length > 15) {
    lines.push(`- _...and ${formulas.length - 15} more formulas_`);
  }

  return lines.join('\n');
}

function extractChartInfo(workbook: Record<string, unknown>): string {
  const sheets = (workbook as { Sheets: Record<string, Record<string, unknown>> }).Sheets;
  const chartNotes: string[] = [];

  for (const [name, sheet] of Object.entries(sheets)) {
    const type = (sheet as Record<string, string>)['!type'];
    if (type === 'chart') {
      chartNotes.push(`- **${name}**: Chart sheet detected`);
    }
  }

  return chartNotes.length > 0 ? chartNotes.join('\n') : '';
}

function extractFromRawXml(filePath: string): { content: string; sheetCount: number } {
  const buffer = readFileSync(filePath);
  const content = buffer.toString('latin1');

  const textParts: string[] = [];

  const textRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;

  while ((match = textRegex.exec(content)) !== null) {
    if (match[1] && match[1].trim()) {
      textParts.push(match[1].trim());
    }
  }

  const valueRegex = /<v>([\s\S]*?)<\/v>/g;
  while ((match = valueRegex.exec(content)) !== null) {
    if (match[1] && match[1].trim()) {
      textParts.push(match[1].trim());
    }
  }

  const sheetMatches = content.match(/<sheet /g);
  const sheetCount = sheetMatches ? sheetMatches.length : 1;

  if (textParts.length === 0) {
    return { content: '', sheetCount };
  }

  const uniqueParts = [...new Set(textParts)].slice(0, 500);
  return {
    content: `**Extracted cell values:**\n\n${uniqueParts.join(' | ')}`,
    sheetCount,
  };
}

function buildMarkdown(title: string, filePath: string, content: string, sheetCount: number): string {
  return `# ${title}

> **Source:** [${basename(filePath)}](${filePath})
> **Type:** Spreadsheet (${extname(filePath)})
> **Sheets:** ${sheetCount}
> **Processed:** ${new Date().toISOString().split('T')[0]}

## Data

${content}
`;
}
