#!/usr/bin/env node
/**
 * CEO vibe-audit script — screenshots every WikiMem surface + captures console errors.
 * Runs against localhost:3456. Writes to /Users/naman/energy/content/screenshots/wikimem-audit-2026-04-24/.
 * Usage: node scripts/vibe-audit.mjs [round-tag]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = '/Users/naman/energy/content/screenshots/wikimem-audit-2026-04-24';
const BASE = 'http://localhost:3456';
const round = process.argv[2] || `r${Date.now().toString().slice(-4)}`;

if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });

const surfaces = [
  { id: 'home',         click: '#rail-files',                name: 'Home / Files (default)' },
  { id: 'graph',        click: '#rail-graph',                name: 'Graph view' },
  { id: 'pipeline',     click: '#rail-pipeline',             name: 'Upload & Ingest / Pipeline' },
  { id: 'history',      click: '#rail-history',              name: 'Source Control' },
  { id: 'timelapse',    click: '#rail-timelapse',            name: 'Time-Lapse' },
  { id: 'connectors',   click: '#rail-connectors',           name: 'Connectors' },
  { id: 'observer',     click: '#rail-observer',             name: 'Observer' },
  { id: 'settings',     click: '#rail-settings',             name: 'Settings' },
  { id: 'search',       click: '#rail-search',               name: 'Search overlay' },
  { id: 'page-concept', evalCall: () => window.openPage && window.openPage('artificial-intelligence'),   name: 'Concept page (AI)' },
  { id: 'page-entity',  evalCall: () => window.openPage && window.openPage('Andrej Karpathy'),           name: 'Entity page (Karpathy)' },
  { id: 'page-tarch',   evalCall: () => window.openPage && window.openPage('transformer-architecture'),  name: 'Entity page (transformer-architecture)' },
];

const report = [];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const consoleErrors = [];
const consoleWarnings = [];
page.on('console', msg => {
  const type = msg.type();
  const text = msg.text();
  if (type === 'error') consoleErrors.push(text);
  else if (type === 'warning') consoleWarnings.push(text);
});
page.on('pageerror', err => consoleErrors.push(`PAGEERROR: ${err.message}`));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1500);

for (const s of surfaces) {
  consoleErrors.length = 0;
  consoleWarnings.length = 0;
  const status = { id: s.id, name: s.name, click: s.click || null, ok: false, err: null, errors: [], warnings: [] };

  try {
    if (s.click) {
      try {
        await page.click(s.click, { timeout: 5000 });
        await page.waitForTimeout(900);
      } catch (e) {
        status.err = `click failed: ${e.message}`;
      }
    } else if (s.evalCall) {
      try {
        await page.evaluate(s.evalCall);
        await page.waitForTimeout(1200);
      } catch (e) {
        status.err = `evalCall failed: ${e.message}`;
      }
    }
    const out = `${OUT}/${s.id}-${round}.png`;
    await page.screenshot({ path: out, fullPage: true });
    status.screenshot = out;
    status.ok = !status.err;
  } catch (e) {
    status.err = e.message;
  }
  status.errors = [...consoleErrors];
  status.warnings = [...consoleWarnings];
  report.push(status);
  console.log(`[${s.id}] ok=${status.ok} err=${status.err || 'none'} console=${status.errors.length}`);
}

// Extended tests — modal opens, search flow, mobile breakpoints
async function extraCheck(id, fn) {
  consoleErrors.length = 0;
  consoleWarnings.length = 0;
  const status = { id, name: id, ok: false, err: null, errors: [], warnings: [] };
  try {
    await fn(status);
    status.ok = !status.err;
  } catch (e) {
    status.err = e.message;
  }
  status.errors = [...consoleErrors];
  status.warnings = [...consoleWarnings];
  report.push(status);
  console.log(`[${id}] ok=${status.ok} err=${status.err || 'none'} console=${status.errors.length}`);
}

// 1. Connectors modal — click Slack card, verify modal opens
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1200);
await extraCheck('connectors-slack-modal', async (st) => {
  try { await page.click('#rail-connectors', { timeout: 4000 }); } catch (e) { st.err = 'rail-connectors click: ' + e.message; return; }
  await page.waitForTimeout(800);
  // Click the Slack card's Connect button (cards use class conn-card with conn-card-name)
  const clicked = await page.evaluate(() => {
    const cards = document.querySelectorAll('.conn-card');
    for (const card of cards) {
      const name = card.querySelector('.conn-card-name')?.textContent?.trim();
      if (name === 'Slack') {
        const btn = card.querySelector('.conn-connect-btn');
        if (btn) { btn.click(); return true; }
      }
    }
    return false;
  });
  if (!clicked) { st.err = 'Slack card or Connect button not found'; }
  await page.waitForTimeout(800);
  const out = `${OUT}/connectors-slack-modal-${round}.png`;
  await page.screenshot({ path: out, fullPage: true });
  st.screenshot = out;
  // DOM probe for modal-ish elements
  const modalSig = await page.evaluate(() => {
    const q = (sel) => !!document.querySelector(sel);
    return {
      dialog: q('dialog[open]'),
      ariaModal: q('[aria-modal="true"]'),
      overlay: q('.modal, .overlay, [data-modal], [data-overlay]'),
      backdrop: q('.backdrop, .modal-backdrop'),
    };
  });
  st.modalSig = modalSig;
});

// 2. Cmd+K search flow: Cmd+K → type → arrow → enter
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1200);
await extraCheck('search-flow-cmdk', async (st) => {
  await page.keyboard.press('Meta+K');
  await page.waitForTimeout(600);
  const out1 = `${OUT}/search-flow-cmdk-open-${round}.png`;
  await page.screenshot({ path: out1, fullPage: false });
  await page.keyboard.type('karpathy', { delay: 30 });
  await page.waitForTimeout(600);
  const out2 = `${OUT}/search-flow-cmdk-typed-${round}.png`;
  await page.screenshot({ path: out2, fullPage: false });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const out3 = `${OUT}/search-flow-cmdk-enter-${round}.png`;
  await page.screenshot({ path: out3, fullPage: true });
  st.screenshot = out3;
  const domSig = await page.evaluate(() => {
    const overlays = document.querySelectorAll('.search-overlay, .quick-switcher, .cmdk, [role="dialog"]');
    const visibleOverlays = Array.from(overlays).filter(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0 && r.height > 0;
    });
    return {
      overlayCount: overlays.length,
      visibleOverlayCount: visibleOverlays.length,
      activeRail: (document.querySelector('.rail-btn.active')?.id) || null,
      title: document.title,
      url: location.href,
      focusedTag: document.activeElement?.tagName,
      focusedPlaceholder: document.activeElement?.placeholder || null,
    };
  });
  st.domSig = domSig;
});

// 3. Command palette (Cmd+P)
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1200);
await extraCheck('command-palette-cmdp', async (st) => {
  await page.keyboard.press('Meta+P');
  await page.waitForTimeout(600);
  const out1 = `${OUT}/command-palette-cmdp-open-${round}.png`;
  await page.screenshot({ path: out1, fullPage: false });
  await page.keyboard.type('graph', { delay: 30 });
  await page.waitForTimeout(400);
  const out2 = `${OUT}/command-palette-cmdp-typed-${round}.png`;
  await page.screenshot({ path: out2, fullPage: false });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const out3 = `${OUT}/command-palette-cmdp-enter-${round}.png`;
  await page.screenshot({ path: out3, fullPage: true });
  st.screenshot = out3;
  const domSig = await page.evaluate(() => {
    const cmdk = document.querySelectorAll('.command-palette, .cmdk, [data-palette], [role="dialog"]');
    const visibleCmdk = Array.from(cmdk).filter(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0 && r.height > 0;
    });
    return {
      activeRail: (document.querySelector('.rail-btn.active')?.id) || null,
      hasCmdkDom: cmdk.length > 0,
      visibleCmdkCount: visibleCmdk.length,
      focusedTag: document.activeElement?.tagName,
      focusedPlaceholder: document.activeElement?.placeholder || null,
      url: location.href,
    };
  });
  st.domSig = domSig;
});

// 4. Right-click sidebar file item — check for context menu
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1200);
await extraCheck('context-menu-rightclick', async (st) => {
  // Find a sidebar file entry — tree-item is the actual class
  const targets = [
    '.tree-item',
    '[data-page-title]',
    '.file-tree .file',
    '.sidebar [data-slug]',
    'a[data-slug]',
    '.file-item',
  ];
  let targetFound = false;
  for (const sel of targets) {
    try {
      await page.click(sel, { button: 'right', timeout: 1500, force: true });
      targetFound = true;
      break;
    } catch (_) { /* try next */ }
  }
  if (!targetFound) { st.err = 'no sidebar file target found'; }
  await page.waitForTimeout(500);
  const out = `${OUT}/context-menu-rightclick-${round}.png`;
  await page.screenshot({ path: out, fullPage: false });
  st.screenshot = out;
  const ctxMenu = await page.evaluate(() => !!document.querySelector('[role="menu"], .context-menu, .ctx-menu'));
  st.ctxMenu = ctxMenu;
});

// 5. Mobile breakpoints on concept page
const breakpoints = [
  { w: 1400, h: 900, name: 'desktop' },
  { w: 900, h: 700, name: 'tablet' },
  { w: 600, h: 400, name: 'mobile' },
];
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1200);
for (const bp of breakpoints) {
  await extraCheck(`breakpoint-${bp.name}`, async (st) => {
    await page.setViewportSize({ width: bp.w, height: bp.h });
    await page.waitForTimeout(600);
    try {
      await page.evaluate(() => window.openPage && window.openPage('artificial-intelligence'));
    } catch (_) { /* ignore */ }
    await page.waitForTimeout(800);
    const out = `${OUT}/breakpoint-${bp.name}-${round}.png`;
    await page.screenshot({ path: out, fullPage: true });
    st.screenshot = out;
    // Check for layout overflow — scan for elements that overflow viewport
    const overflow = await page.evaluate((vw) => {
      const wide = [];
      const els = document.querySelectorAll('body *');
      for (const el of Array.from(els).slice(0, 400)) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 5 && r.width > 100) {
          wide.push({ tag: el.tagName, cls: el.className?.toString().slice(0, 40), right: Math.round(r.right), w: Math.round(r.width) });
          if (wide.length > 8) break;
        }
      }
      return wide;
    }, bp.w);
    st.overflow = overflow;
  });
}

// Restore viewport
await page.setViewportSize({ width: 1400, height: 900 });

// Keyboard shortcut tests
const shortcutTests = [
  { key: 'Meta+K', name: 'quick-switcher' },
  { key: 'Meta+P', name: 'command-palette' },
  { key: 'Meta+B', name: 'sidebar-collapse' },
  { key: 'Meta+G', name: 'graph' },
  { key: 'Meta+,', name: 'settings' },
];
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(1200);
for (const t of shortcutTests) {
  consoleErrors.length = 0;
  try {
    await page.keyboard.press(t.key);
    await page.waitForTimeout(400);
    const out = `${OUT}/shortcut-${t.name}-${round}.png`;
    await page.screenshot({ path: out, fullPage: false });
    report.push({ id: `shortcut-${t.name}`, name: `keyboard ${t.key}`, ok: true, screenshot: out, errors: [...consoleErrors] });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log(`[shortcut-${t.name}] sent`);
  } catch (e) {
    report.push({ id: `shortcut-${t.name}`, name: `keyboard ${t.key}`, ok: false, err: e.message });
  }
}

await browser.close();

const summary = {
  round,
  timestamp: new Date().toISOString(),
  totalSurfaces: surfaces.length,
  totalShortcuts: shortcutTests.length,
  surfacesWithErrors: report.filter(r => r.errors && r.errors.length).length,
  surfacesFailed: report.filter(r => !r.ok).length,
  report,
};
await writeFile(`${OUT}/vibe-audit-${round}.json`, JSON.stringify(summary, null, 2));

console.log('\n=== SUMMARY ===');
console.log(`Round: ${round}`);
console.log(`Surfaces screenshotted: ${surfaces.length}`);
console.log(`Shortcuts tested: ${shortcutTests.length}`);
console.log(`Surfaces with console errors: ${summary.surfacesWithErrors}`);
console.log(`Surfaces that failed: ${summary.surfacesFailed}`);
console.log(`Report JSON: ${OUT}/vibe-audit-${round}.json`);

for (const r of report) {
  if (r.errors && r.errors.length) {
    console.log(`\n[${r.id}] console errors:`);
    for (const e of r.errors) console.log(`  - ${e}`);
  }
  if (r.err) console.log(`[${r.id}] FAILED: ${r.err}`);
}
