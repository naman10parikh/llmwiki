import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { getVaultConfig } from '../../core/vault.js';
import { createServer } from '../../web/server.js';

interface ServeOptions {
  vault?: string;
  port?: string;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the web UI for your knowledge base')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --port <number>', 'Port to listen on', '3141')
    .action((options: ServeOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a wikimem vault. Run `wikimem init` first.'));
        process.exit(1);
      }

      const port = parseInt(options.port ?? '3141', 10);
      console.log(chalk.blue('Starting wikimem web UI...'));
      createServer(vaultRoot, port);
    });
}
