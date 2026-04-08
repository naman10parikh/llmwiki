import { Command } from 'commander';
import chalk from 'chalk';
import { getVaultConfig } from '../../core/vault.js';
import { listSnapshots, restoreSnapshot } from '../../core/history.js';

export function registerHistoryCommand(program: Command): void {
  const historyCmd = program
    .command('history')
    .description('View wiki change history and restore snapshots');

  historyCmd
    .command('list')
    .alias('ls')
    .description('Show all history entries')
    .option('-n, --limit <count>', 'Number of entries to show', '20')
    .action((options: { limit: string }) => {
      const config = getVaultConfig('.');
      const entries = listSnapshots(config);
      const limit = parseInt(options.limit, 10) || 20;
      const shown = entries.slice(0, limit);

      if (shown.length === 0) {
        console.log(chalk.dim('No history entries yet. History is recorded after ingest, scrape, and improve operations.'));
        return;
      }

      console.log();
      console.log(chalk.bold(`Wiki History (${shown.length} of ${entries.length} entries)`));
      console.log();

      const automationColors: Record<string, (s: string) => string> = {
        ingest: chalk.green,
        scrape: chalk.blue,
        improve: chalk.magenta,
        manual: chalk.white,
        restore: chalk.yellow,
      };

      for (const entry of shown) {
        const colorFn = automationColors[entry.automation] ?? chalk.white;
        const date = new Date(entry.timestamp).toLocaleString();
        const badge = colorFn(`[${entry.automation}]`);
        console.log(`  ${chalk.dim(entry.id)}  ${badge}  ${entry.summary}`);
        console.log(chalk.dim(`    ${date}  •  ${entry.filesChanged.length} files`));
      }

      console.log();
      console.log(chalk.dim(`  Restore: wikimem history restore <id>`));
    });

  historyCmd
    .command('restore <snapshot-id>')
    .description('Restore wiki to a previous snapshot')
    .action((snapshotId: string) => {
      const config = getVaultConfig('.');
      console.log(chalk.blue(`Restoring wiki to snapshot ${snapshotId}...`));
      const result = restoreSnapshot(config, snapshotId);
      if (result.restored) {
        console.log(chalk.green(`✓ ${result.message}`));
      } else {
        console.error(chalk.red(`✗ ${result.message}`));
        process.exit(1);
      }
    });

  historyCmd.action(() => {
    historyCmd.commands.find(c => c.name() === 'list')?.parse(process.argv.slice(2));
  });
}
