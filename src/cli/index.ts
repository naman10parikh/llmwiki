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
import { registerMcpCommand } from './commands/mcp.js';
import { registerSearchCommand } from './commands/search.js';
import { registerAskCommand } from './commands/ask.js';
import { registerOpenCommand } from './commands/open.js';
import { registerExportCommand } from './commands/export.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerAddSourceCommand } from './commands/add-source.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('wikimem')
    .description('Build self-improving knowledge bases with LLMs. Ingest anything, query everything, auto-evolve.')
    .version(getVersion());

  registerInitCommand(program);
  registerIngestCommand(program);
  registerAddSourceCommand(program);
  registerQueryCommand(program);
  registerSearchCommand(program);
  registerAskCommand(program);
  registerLintCommand(program);
  registerStatusCommand(program);
  registerWatchCommand(program);
  registerScrapeCommand(program);
  registerImproveCommand(program);
  registerDuplicatesCommand(program);
  registerServeCommand(program);
  registerOpenCommand(program);
  registerExportCommand(program);
  registerPublishCommand(program);
  registerHistoryCommand(program);
  registerMcpCommand(program);

  return program;
}
