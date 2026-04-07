You are working on wikimem at /Users/naman/llmwiki.

Task: Add auto-update detection. When any CLI command runs, check npm for newer version. If available, show a one-line notice AFTER command output (not before, don't delay the command).

Implementation:
1. Create src/core/update-checker.ts
2. On every CLI run, check if ~/.wikimem/last-update-check exists and is < 24h old. If so, skip.
3. If stale or missing, fetch https://registry.npmjs.org/wikimem/latest in background (non-blocking)
4. Compare with current version from package.json
5. If newer available, print: "Update available: 0.1.3 → 0.2.0 — run: npm install -g wikimem@latest"
6. Save timestamp to ~/.wikimem/last-update-check
7. Wire into src/cli/index.ts — call after program.parse()
8. Must NOT slow down CLI startup — the check runs async, prints after command completes

Build and test: cd /Users/naman/llmwiki && pnpm build && pnpm test
