import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerIngestCommand } from './commands/ingest.js';
import { registerQueryCommand } from './commands/query.js';
import { registerLintCommand } from './commands/lint.js';
import { registerStatusCommand } from './commands/status.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerScrapeCommand } from './commands/scrape.js';
import { registerImproveCommand } from './commands/improve.js';
import { registerDuplicatesCommand } from './commands/duplicates.js';
import { registerServeCommand } from './commands/serve.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('wikimem')
    .description('Build self-improving knowledge bases with LLMs. Ingest anything, query everything, auto-evolve.')
    .version('0.1.0');

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

  return program;
}
