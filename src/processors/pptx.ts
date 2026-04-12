/**
 * PowerPoint (.pptx) processor.
 * Extracts slides via zip (adm-zip) + XML parsing.
 * Features: slide titles, body text with bullet/numbered list structure,
 * speaker notes, image alt-text, proper paragraph grouping.
 */

import { basename } from 'node:path';
import AdmZip from 'adm-zip';

export interface PptxResult {
  title: string;
  content: string;
  markdown: string;
  slideCount: number;
  sourcePath: string;
}

interface Paragraph {
  text: string;
  level: number;       // indentation level (0-based)
  bullet: 'none' | 'bullet' | 'numbered';
  isBold: boolean;
}

interface SlideContent {
  slideNumber: number;
  title: string;
  paragraphs: Paragraph[];
  notes: string[];
  imageAlts: string[];
}

export async function processPptx(filePath: string): Promise<PptxResult> {
  const title = basename(filePath, '.pptx');

  let slides: SlideContent[];
  try {
    slides = extractSlides(filePath);
  } catch {
    return {
      title,
      content: `[PowerPoint — extraction failed for ${basename(filePath)}]`,
      markdown: buildMarkdown(title, filePath, '[Extraction failed — file may be corrupted]', 0),
      slideCount: 0,
      sourcePath: filePath,
    };
  }

  const slideCount = slides.length;
  let content: string;

  if (slides.length > 0) {
    content = slides.map(formatSlide).join('\n\n---\n\n');
  } else {
    content = `[PowerPoint — no text content extracted from ${basename(filePath)}]`;
  }

  return {
    title,
    content,
    markdown: buildMarkdown(title, filePath, content, slideCount),
    slideCount,
    sourcePath: filePath,
  };
}

function extractSlides(filePath: string): SlideContent[] {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  const slideEntries: Map<number, string> = new Map();
  const noteEntries: Map<number, string> = new Map();

  for (const entry of entries) {
    const name = entry.entryName;

    const slideMatch = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (slideMatch?.[1]) {
      slideEntries.set(parseInt(slideMatch[1], 10), entry.getData().toString('utf-8'));
    }

    const noteMatch = name.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
    if (noteMatch?.[1]) {
      noteEntries.set(parseInt(noteMatch[1], 10), entry.getData().toString('utf-8'));
    }
  }

  const slideNumbers = [...slideEntries.keys()].sort((a, b) => a - b);
  const slides: SlideContent[] = [];

  for (const num of slideNumbers) {
    const slideXml = slideEntries.get(num) ?? '';
    const noteXml = noteEntries.get(num) ?? '';

    const title = extractSlideTitle(slideXml);
    const paragraphs = extractBodyParagraphs(slideXml, title);
    const notes = noteXml ? extractNotesText(noteXml) : [];
    const imageAlts = extractImageAltTexts(slideXml);

    slides.push({ slideNumber: num, title, paragraphs, notes, imageAlts });
  }

  return slides;
}

/**
 * Extract slide title from <p:sp> with <p:ph type="title"> or type="ctrTitle".
 */
function extractSlideTitle(xml: string): string {
  const titleTypes = ['title', 'ctrTitle'];

  for (const phType of titleTypes) {
    const phPattern = new RegExp(
      `<p:sp>([\\s\\S]*?)<p:ph[^>]*type="${phType}"[^>]*/?>([\\s\\S]*?)</p:sp>`,
      'g'
    );
    let match: RegExpExecArray | null;
    while ((match = phPattern.exec(xml)) !== null) {
      const texts = extractRawTextFromXml(match[0]);
      if (texts.length > 0) return texts.join(' ');
    }
  }

  return '';
}

/**
 * Extract body paragraphs with bullet/list detection.
 * Parses <a:p> elements within shapes, detecting:
 * - <a:buChar char="•"/> or similar → bullet point
 * - <a:buAutoNum type="arabicPeriod"/> → numbered list
 * - <a:buNone/> → no bullet (plain paragraph)
 * - <a:pPr lvl="N"/> → indentation level
 * - <a:rPr b="1"/> → bold text
 */
function extractBodyParagraphs(xml: string, titleText: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Extract all shape bodies, skipping title/subtitle placeholders
  const shapeRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let shapeMatch: RegExpExecArray | null;

  while ((shapeMatch = shapeRegex.exec(xml)) !== null) {
    const shapeXml = shapeMatch[1] ?? '';

    // Skip title/subtitle placeholder shapes
    if (/<p:ph[^>]*type="(title|ctrTitle|subTitle)"/.test(shapeXml)) continue;
    // Skip slide number, date, footer placeholders
    if (/<p:ph[^>]*type="(sldNum|dt|ftr)"/.test(shapeXml)) continue;

    // Extract <p:txBody> content
    const txBodyMatch = shapeXml.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
    if (!txBodyMatch?.[1]) continue;

    const txBody = txBodyMatch[1];
    const parsedParagraphs = parseParagraphs(txBody);

    for (const p of parsedParagraphs) {
      // Skip if text matches title or is a pure number/date
      if (p.text === titleText) continue;
      if (/^\d+$/.test(p.text) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(p.text)) continue;
      paragraphs.push(p);
    }
  }

  return paragraphs;
}

/**
 * Parse <a:p> elements from a txBody, detecting bullets and levels.
 */
function parseParagraphs(txBodyXml: string): Paragraph[] {
  const result: Paragraph[] = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let match: RegExpExecArray | null;

  while ((match = paraRegex.exec(txBodyXml)) !== null) {
    const paraXml = match[1] ?? '';

    // Extract indentation level from <a:pPr lvl="N">
    const levelMatch = paraXml.match(/<a:pPr[^>]*\blvl="(\d+)"/);
    const level = levelMatch?.[1] ? parseInt(levelMatch[1], 10) : 0;

    // Detect bullet type
    let bullet: Paragraph['bullet'] = 'none';
    if (/<a:buChar\b/.test(paraXml)) {
      bullet = 'bullet';
    } else if (/<a:buAutoNum\b/.test(paraXml)) {
      bullet = 'numbered';
    } else if (/<a:buNone\s*\/>/.test(paraXml)) {
      bullet = 'none';
    } else if (/<a:pPr\b/.test(paraXml) && !/<a:buNone/.test(paraXml) && level > 0) {
      // If there's a pPr with a level but no explicit buNone, it's likely a bullet
      bullet = 'bullet';
    }

    // Check for bold
    const isBold = /<a:rPr[^>]*\bb="1"/.test(paraXml);

    // Extract text runs
    const texts: string[] = [];
    const runRegex = /<a:r>([\s\S]*?)<\/a:r>/g;
    let runMatch: RegExpExecArray | null;
    while ((runMatch = runRegex.exec(paraXml)) !== null) {
      const tMatch = (runMatch[1] ?? '').match(/<a:t>([\s\S]*?)<\/a:t>/);
      if (tMatch?.[1]?.trim()) {
        texts.push(decodeXmlEntities(tMatch[1].trim()));
      }
    }

    // Also check for <a:fld> (field) text runs (e.g., slide numbers in body)
    const fldRegex = /<a:fld[^>]*>([\s\S]*?)<\/a:fld>/g;
    let fldMatch: RegExpExecArray | null;
    while ((fldMatch = fldRegex.exec(paraXml)) !== null) {
      const tMatch = (fldMatch[1] ?? '').match(/<a:t>([\s\S]*?)<\/a:t>/);
      if (tMatch?.[1]?.trim()) {
        texts.push(decodeXmlEntities(tMatch[1].trim()));
      }
    }

    const text = texts.join(' ');
    if (text.length > 0) {
      result.push({ text, level, bullet, isBold });
    }
  }

  return result;
}

/**
 * Extract image alt-text from <p:pic> elements.
 * Alt text is stored in: <p:cNvPr id="..." name="..." descr="Alt text here"/>
 */
function extractImageAltTexts(xml: string): string[] {
  const alts: string[] = [];

  // Look for p:pic shapes with descr attribute
  const picRegex = /<p:pic>([\s\S]*?)<\/p:pic>/g;
  let match: RegExpExecArray | null;

  while ((match = picRegex.exec(xml)) !== null) {
    const picXml = match[1] ?? '';
    // descr attribute on cNvPr holds alt text
    const descrMatch = picXml.match(/descr="([^"]+)"/);
    if (descrMatch?.[1]) {
      alts.push(decodeXmlEntities(descrMatch[1]));
    }
    // Also check for <a:hlinkClick> tooltip as fallback
    const tooltipMatch = picXml.match(/tooltip="([^"]+)"/);
    if (tooltipMatch?.[1] && !descrMatch) {
      alts.push(decodeXmlEntities(tooltipMatch[1]));
    }
  }

  // Also check <wsp> (WordArt/shapes) and <p:sp> with images
  const spRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  while ((match = spRegex.exec(xml)) !== null) {
    const spXml = match[1] ?? '';
    if (/<a:blipFill>/.test(spXml)) {
      const descrMatch = spXml.match(/<p:cNvPr[^>]*descr="([^"]+)"/);
      if (descrMatch?.[1]) {
        alts.push(decodeXmlEntities(descrMatch[1]));
      }
    }
  }

  return alts;
}

/**
 * Extract speaker notes text from notesSlide XML.
 * Parses at paragraph level for better structure.
 */
function extractNotesText(noteXml: string): string[] {
  const paragraphs = parseParagraphs(noteXml);
  return paragraphs
    .map((p) => p.text)
    .filter((t) => {
      if (/^\d+$/.test(t)) return false;
      if (t.length < 2) return false;
      return true;
    });
}

function extractRawTextFromXml(xml: string): string[] {
  const texts: string[] = [];
  const textRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const text = match[1]?.trim();
    if (text && text.length > 0) texts.push(decodeXmlEntities(text));
  }
  return texts;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code as string, 10)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, code) => String.fromCharCode(parseInt(code as string, 16)));
}

function formatSlide(slide: SlideContent): string {
  const parts: string[] = [];

  // Heading
  if (slide.title) {
    parts.push(`## Slide ${slide.slideNumber}: ${slide.title}`);
  } else {
    parts.push(`## Slide ${slide.slideNumber}`);
  }

  // Body paragraphs with proper bullet/list formatting
  if (slide.paragraphs.length > 0) {
    let numberedCounter = 0;
    const bodyLines: string[] = [];

    for (const p of slide.paragraphs) {
      const indent = '  '.repeat(p.level);
      const text = p.isBold ? `**${p.text}**` : p.text;

      if (p.bullet === 'numbered') {
        numberedCounter++;
        bodyLines.push(`${indent}${numberedCounter}. ${text}`);
      } else if (p.bullet === 'bullet') {
        numberedCounter = 0;
        bodyLines.push(`${indent}- ${text}`);
      } else {
        numberedCounter = 0;
        bodyLines.push(`${indent}${text}`);
      }
    }

    parts.push(bodyLines.join('\n'));
  } else {
    parts.push('_[No body text]_');
  }

  // Image alt-texts
  if (slide.imageAlts.length > 0) {
    parts.push(`**Images:** ${slide.imageAlts.map((a) => `_${a}_`).join(', ')}`);
  }

  // Speaker notes
  if (slide.notes.length > 0) {
    parts.push(`**Speaker Notes:**\n\n> ${slide.notes.join('\n> ')}`);
  }

  return parts.join('\n\n');
}

function buildMarkdown(title: string, filePath: string, content: string, slideCount: number): string {
  return `# ${title}

> **Source:** [${basename(filePath)}](${filePath})
> **Type:** PowerPoint Presentation (.pptx)
> **Slides:** ${slideCount}
> **Processed:** ${new Date().toISOString().split('T')[0]}

${content}
`;
}
