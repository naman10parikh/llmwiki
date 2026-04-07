import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { getVaultConfig } from '../../core/vault.js';
import { listDuplicates } from '../../core/ingest.js';

interface DuplicatesOptions {
  vault?: string;
  json?: boolean;
}

export function registerDuplicatesCommand(program: Command): void {
  program
    .command('duplicates')
    .description('List all files rejected as duplicates during ingestion')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('--json', 'Output as JSON')
    .action((options: DuplicatesOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const duplicates = listDuplicates(config.rawDir);

      if (duplicates.length === 0) {
        console.log(chalk.dim('No rejected duplicates found.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(duplicates, null, 2));
        return;
      }

      console.log(chalk.cyan(`\nFound ${duplicates.length} rejected duplicate(s):\n`));

      for (const dup of duplicates) {
        console.log(chalk.white(`  ${dup.title}`));
        console.log(chalk.dim(`    File:     ${dup.file}`));
        console.log(chalk.yellow(`    Reason:   ${dup.reason}`));
        console.log(chalk.dim(`    Similar:  ${dup.similarTo}`));
        console.log(chalk.dim(`    Score:    ${Math.round(dup.score * 100)}%`));
        if (dup.date) {
          console.log(chalk.dim(`    Date:     ${dup.date}`));
        }
        console.log('');
      }

      console.log(chalk.dim(`Tip: Use ${chalk.white('wikimem ingest <file> --force')} to override a rejection.\n`));
    });
}
