import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { queryWiki } from '../../core/query.js';
import { getVaultConfig } from '../../core/vault.js';
import { createProvider } from '../../providers/index.js';
import { loadConfig } from '../../core/config.js';

interface QueryOptions {
  vault?: string;
  provider?: string;
  model?: string;
  file?: boolean;
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query <question>')
    .description('Ask a question against the wiki')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider (claude, openai, ollama)')
    .option('-m, --model <model>', 'Model to use')
    .option('--file', 'Save the answer as a new wiki page')
    .action(async (question: string, options: QueryOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a wikimem vault. Run `wikimem init` first.'));
        process.exit(1);
      }

      const providerName = options.provider ?? userConfig.provider ?? 'claude';
      const model = options.model ?? userConfig.model;
      const provider = createProvider(providerName, { model });

      const spinner = ora('Searching wiki and synthesizing answer...').start();

      try {
        const result = await queryWiki(question, config, provider, {
          fileBack: options.file ?? false,
        });

        spinner.stop();
        console.log();
        console.log(chalk.bold('Answer:'));
        console.log();
        console.log(result.answer);
        console.log();
        console.log(chalk.dim(`Sources consulted: ${result.sourcesConsulted.join(', ')}`));

        if (result.filedAs) {
          console.log(chalk.green(`Answer filed as: ${result.filedAs}`));
        }
      } catch (error) {
        spinner.fail(chalk.red('Query failed'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
