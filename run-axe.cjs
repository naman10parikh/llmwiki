const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  try {
    await p.goto('http://localhost:3456/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await p.waitForTimeout(2500);
  } catch (e) { console.error('Goto:', e.message); }
  await p.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/axe-core@4.10.0/axe.min.js' });
  await p.waitForTimeout(1500);
  const results = await p.evaluate(async () => { try { return await window.axe.run(); } catch(e) { return {error: String(e)}; } });
  const outfile = process.argv[2] || '/tmp/axe-results-pre.json';
  fs.writeFileSync(outfile, JSON.stringify(results.violations || results, null, 2));
  console.log('Violations:', (results.violations || []).length);
  if (results.violations) {
    for (const v of results.violations) {
      console.log(`\n[${v.impact}] ${v.id} (${v.nodes.length} nodes): ${v.help}`);
      for (const n of v.nodes) {
        console.log('   ->', n.target.join(', '));
        if (n.any[0]) console.log('     ', n.any[0].message);
      }
    }
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
