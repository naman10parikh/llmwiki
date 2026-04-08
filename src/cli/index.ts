import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { registerInitCommand } from './commands/init.js';

function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}
import { registerIngestCommand } from './commands/ingest.js';
import { registerQueryCommand } from './commands/query.js';
import { registerLintCommand } from './commands/lint.js';
import { registerStatusCommand } from './commands/status.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerScrapeCommand } from './commands/scrape.js';
import { registerImproveCommand } from './commands/improve.js';
import { registerDuplicatesCommand } from './commands/duplicates.js';
import { registerServeCommand } from './commands/serve.js';
import { registerHistoryCommand } from './commands/history.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('wikimem')
    .description('Build self-improving knowledge bases with LLMs. Ingest anything, query everything, auto-evolve.')
    .version(getVersion());

  registerInitCommand(program);
  registerIngestCommand(program);
  registerQueryCommand(program);
  registerLintCommand(program);
  registerStatusCommand(program);
  registerWatchCommand(program);
  registerScrapeCommand(program);
  registerImproveCommand(program);
  registerDuplicatesCommand(program);
  registerServeCommand(program);
  registerHistoryCommand(program);

  return program;
}
