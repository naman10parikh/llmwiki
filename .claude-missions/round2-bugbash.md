You are working on wikimem at /Users/naman/llmwiki.

Task: Full bug bash. Test EVERY command as a new user would. Find and fix bugs.

Setup:
export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY /Users/naman/energy/.env | cut -d= -f2)

Test sequence:
1. node dist/index.js init /tmp/bugbash --template personal
2. node dist/index.js status --vault /tmp/bugbash
3. node dist/index.js lint --vault /tmp/bugbash (should NOT show orphan for index/log)
4. node dist/index.js ingest /Users/naman/energy/resources/unread/claudeopedia.md --vault /tmp/bugbash --tags "wiki,karpathy"
5. node dist/index.js query "What is Claudeopedia?" --vault /tmp/bugbash
6. node dist/index.js duplicates --vault /tmp/bugbash
7. node dist/index.js ingest /Users/naman/energy/resources/unread/claudeopedia.md --vault /tmp/bugbash (should detect duplicate)
8. node dist/index.js improve --vault /tmp/bugbash --dry-run
9. node dist/index.js serve --vault /tmp/bugbash (verify web UI loads at localhost:3141)

For EVERY bug found: fix it, run pnpm build && pnpm test, verify fix.
Write bug report at /Users/naman/llmwiki/.claude-signals/bugbash-report.md
