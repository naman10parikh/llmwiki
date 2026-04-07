import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getVaultConfig } from '../../core/vault.js';
import { createProvider } from '../../providers/index.js';
import { loadConfig } from '../../core/config.js';
import { improveWiki } from '../../core/improve.js';

interface ImproveOptions {
  vault?: string;
  provider?: string;
  threshold?: string;
  dryRun?: boolean;
}

export function registerImproveCommand(program: Command): void {
  program
    .command('improve')
    .description('Self-improve the wiki using LLM Council review (Automation 3)')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider')
    .option('--threshold <score>', 'Quality threshold (0-100, default 80)', '80')
    .option('--dry-run', 'Show what would be changed without modifying')
    .action(async (options: ImproveOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a llmwiki vault. Run `llmwiki init` first.'));
        process.exit(1);
      }

      const providerName = options.provider ?? userConfig.provider ?? 'claude';
      const provider = createProvider(providerName);
      const threshold = parseInt(options.threshold ?? '80', 10);

      const spinner = ora('Evaluating wiki quality...').start();

      try {
        const result = await improveWiki(config, provider, {
          threshold,
          dryRun: options.dryRun ?? false,
        });

        spinner.stop();
        console.log();
        console.log(chalk.bold(`Wiki Quality Score: ${result.score}/100`));
        console.log();

        // Show dimension scores
        for (const [dim, score] of Object.entries(result.dimensions)) {
          const color = score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
          console.log(`  ${dim}: ${color(String(score))}/100`);
        }

        console.log();

        if (result.score >= threshold) {
          console.log(chalk.green(`Score ${result.score} >= threshold ${threshold}. Wiki is healthy!`));
        } else {
          console.log(chalk.yellow(`Score ${result.score} < threshold ${threshold}. Improvements needed.`));
          console.log();

          if (options.dryRun) {
            console.log(chalk.dim('Dry run — showing proposed changes:'));
          } else {
            console.log(chalk.blue('Applying improvements:'));
          }

          for (const action of result.actions) {
            const prefix = options.dryRun ? chalk.dim('[dry-run]') : chalk.green('[applied]');
            console.log(`  ${prefix} ${action.type}: ${action.description}`);
          }
        }
      } catch (error) {
        spinner.fail(chalk.red('Improvement cycle failed'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
