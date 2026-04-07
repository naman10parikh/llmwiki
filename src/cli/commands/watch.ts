import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getVaultConfig } from '../../core/vault.js';
import { createProvider } from '../../providers/index.js';
import { loadConfig } from '../../core/config.js';
import { watchRawDirectory } from '../../core/watcher.js';

interface WatchOptions {
  vault?: string;
  provider?: string;
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch raw/ directory and auto-ingest new files')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider')
    .action(async (options: WatchOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a llmwiki vault. Run `llmwiki init` first.'));
        process.exit(1);
      }

      const providerName = options.provider ?? userConfig.provider ?? 'claude';
      const provider = createProvider(providerName);

      console.log(chalk.blue(`Watching ${config.rawDir} for new files...`));
      console.log(chalk.dim('Press Ctrl+C to stop.'));

      await watchRawDirectory(config, provider);
    });
}
