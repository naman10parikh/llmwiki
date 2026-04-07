import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ingestSource } from '../../core/ingest.js';
import { getVaultConfig } from '../../core/vault.js';
import { createProvider } from '../../providers/index.js';
import { loadConfig } from '../../core/config.js';

interface IngestOptions {
  vault?: string;
  provider?: string;
  model?: string;
  verbose?: boolean;
}

export function registerIngestCommand(program: Command): void {
  program
    .command('ingest <source>')
    .description('Ingest a source file or URL into the wiki')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider (claude, openai, ollama)')
    .option('-m, --model <model>', 'Model to use')
    .option('--verbose', 'Show detailed output')
    .action(async (source: string, options: IngestOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a llmwiki vault. Run `llmwiki init` first.'));
        process.exit(1);
      }

      const providerName = options.provider ?? userConfig.provider ?? 'claude';
      const model = options.model ?? userConfig.model;
      const provider = createProvider(providerName, { model });

      const spinner = ora(`Ingesting ${source}...`).start();

      try {
        const result = await ingestSource(source, config, provider, {
          verbose: options.verbose ?? false,
        });

        spinner.succeed(chalk.green(`Ingested: ${result.title}`));
        console.log(chalk.dim(`  Pages created/updated: ${result.pagesUpdated}`));
        console.log(chalk.dim(`  Wiki links added: ${result.linksAdded}`));
        console.log(chalk.dim(`  Source saved to: ${result.rawPath}`));
      } catch (error) {
        spinner.fail(chalk.red('Ingestion failed'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
