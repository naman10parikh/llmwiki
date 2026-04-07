import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultConfig } from './vault.js';
import { listWikiPages, readWikiPage } from './vault.js';
import { basename, extname } from 'node:path';

/**
 * Obsidian integration — generates .obsidian/ config directory
 * for optimal graph display when `wikimem init` runs.
 */

export interface ObsidianConfig {
  app: AppConfig;
  graph: GraphConfig;
  appearance: AppearanceConfig;
}

export interface AppConfig {
  livePreview: boolean;
  readableLineLength: boolean;
  showFrontmatter: boolean;
  strictLineBreaks: boolean;
  useMarkdownLinks: boolean;
  showLineNumber: boolean;
  foldHeading: boolean;
  foldIndent: boolean;
}

export interface GraphConfig {
  collapse_filter: boolean;
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  hideUnresolved: boolean;
  showOrphans: boolean;
  collapse_color: boolean;
  colorGroups: GraphColorGroup[];
  collapse_display: boolean;
  showArrow: boolean;
  textFadeMultiplier: number;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  collapse_forces: boolean;
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

export interface GraphColorGroup {
  query: string;
  color: { a: number; r: number; g: number; b: number };
}

export interface AppearanceConfig {
  accentColor: string;
  theme: string;
  cssTheme: string;
}

export interface GraphHint {
  nodes: GraphHintNode[];
  edges: GraphHintEdge[];
  stats: { nodeCount: number; edgeCount: number; orphanCount: number };
}

export interface GraphHintNode {
  id: string;
  title: string;
  type: string;
  linkCount: number;
}

export interface GraphHintEdge {
  source: string;
  target: string;
}

function getDefaultAppConfig(): AppConfig {
  return {
    livePreview: true,
    readableLineLength: true,
    showFrontmatter: true,
    strictLineBreaks: false,
    useMarkdownLinks: false,
    showLineNumber: false,
    foldHeading: true,
    foldIndent: true,
  };
}

function getDefaultGraphConfig(): GraphConfig {
  return {
    collapse_filter: false,
    search: '',
    showTags: true,
    showAttachments: false,
    hideUnresolved: false,
    showOrphans: true,
    collapse_color: false,
    colorGroups: [
      { query: 'path:wiki/sources', color: { a: 1, r: 100, g: 180, b: 255 } },
      { query: 'path:wiki/entities', color: { a: 1, r: 255, g: 150, b: 80 } },
      { query: 'path:wiki/concepts', color: { a: 1, r: 130, g: 220, b: 130 } },
      { query: 'path:wiki/syntheses', color: { a: 1, r: 200, g: 130, b: 255 } },
    ],
    collapse_display: false,
    showArrow: true,
    textFadeMultiplier: 0,
    nodeSizeMultiplier: 1.2,
    lineSizeMultiplier: 1,
    collapse_forces: false,
    centerStrength: 0.5,
    repelStrength: 10,
    linkStrength: 1,
    linkDistance: 30,
  };
}

function getDefaultAppearanceConfig(): AppearanceConfig {
  return {
    accentColor: '#7c3aed',
    theme: 'obsidian',
    cssTheme: '',
  };
}

export function getDefaultObsidianConfig(): ObsidianConfig {
  return {
    app: getDefaultAppConfig(),
    graph: getDefaultGraphConfig(),
    appearance: getDefaultAppearanceConfig(),
  };
}

/**
 * Generate the .obsidian/ directory with optimal config files
 * for displaying an llmwiki vault.
 */
export function setupObsidian(root: string): void {
  const obsidianDir = join(root, '.obsidian');
  if (!existsSync(obsidianDir)) {
    mkdirSync(obsidianDir, { recursive: true });
  }

  const config = getDefaultObsidianConfig();

  writeFileSync(
    join(obsidianDir, 'app.json'),
    JSON.stringify(config.app, null, 2),
    'utf-8',
  );

  writeFileSync(
    join(obsidianDir, 'graph.json'),
    JSON.stringify(config.graph, null, 2),
    'utf-8',
  );

  writeFileSync(
    join(obsidianDir, 'appearance.json'),
    JSON.stringify(config.appearance, null, 2),
    'utf-8',
  );
}

/**
 * Generate a graph.json hint file for quick graph rendering.
 * Reads all wiki pages and builds a node/edge adjacency list.
 */
export function generateGraphHint(config: VaultConfig): GraphHint {
  const pages = listWikiPages(config.wikiDir);
  const nodes: GraphHintNode[] = [];
  const edges: GraphHintEdge[] = [];
  const titleSet = new Set<string>();
  const linkedTo = new Set<string>();

  for (const pagePath of pages) {
    try {
      const page = readWikiPage(pagePath);
      const type = (page.frontmatter['type'] as string) ?? 'unknown';
      titleSet.add(page.title);
      nodes.push({
        id: page.title,
        title: page.title,
        type,
        linkCount: page.wikilinks.length,
      });
      for (const link of page.wikilinks) {
        edges.push({ source: page.title, target: link });
        linkedTo.add(link);
      }
    } catch {
      // Skip unreadable pages
    }
  }

  const orphanCount = nodes.filter(
    (n) => !linkedTo.has(n.id) && n.id !== 'index' && n.id !== 'log',
  ).length;

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      orphanCount,
    },
  };
}

/**
 * Write the graph hint to disk for quick graph rendering.
 */
export function writeGraphHint(root: string, hint: GraphHint): void {
  const hintPath = join(root, '.obsidian', 'graph-hint.json');
  const obsidianDir = join(root, '.obsidian');
  if (!existsSync(obsidianDir)) {
    mkdirSync(obsidianDir, { recursive: true });
  }
  writeFileSync(hintPath, JSON.stringify(hint, null, 2), 'utf-8');
}
