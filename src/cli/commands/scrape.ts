import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getVaultConfig } from '../../core/vault.js';
import { loadConfig } from '../../core/config.js';
import { scrapeExternalSources } from '../../core/scrape.js';

interface ScrapeOptions {
  vault?: string;
  source?: string;
}

export function registerScrapeCommand(program: Command): void {
  program
    .command('scrape')
    .description('Fetch content from configured external sources (Automation 2)')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-s, --source <name>', 'Scrape a specific source from config')
    .action(async (options: ScrapeOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a llmwiki vault. Run `llmwiki init` first.'));
        process.exit(1);
      }

      const sources = userConfig.sources ?? [];
      if (sources.length === 0) {
        console.error(chalk.yellow('No external sources configured in config.yaml.'));
        console.log(chalk.dim('Add sources to config.yaml under the "sources:" key.'));
        process.exit(1);
      }

      const spinner = ora('Scraping external sources...').start();

      try {
        const result = await scrapeExternalSources(config, userConfig, options.source);
        spinner.succeed(chalk.green(`Scraped ${result.filesDeposited} files from ${result.sourcesProcessed} source(s)`));

        for (const entry of result.entries) {
          console.log(chalk.dim(`  ${entry.source}: ${entry.files} file(s) → raw/${entry.date}/`));
        }

        if (result.filesDeposited > 0) {
          console.log();
          console.log(chalk.dim('Run `llmwiki ingest` to process new raw files into the wiki.'));
        }
      } catch (error) {
        spinner.fail(chalk.red('Scraping failed'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
