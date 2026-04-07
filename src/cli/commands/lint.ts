import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { lintWiki } from '../../core/lint.js';
import { getVaultConfig } from '../../core/vault.js';
import { createProvider } from '../../providers/index.js';
import { loadConfig } from '../../core/config.js';

interface LintOptions {
  vault?: string;
  provider?: string;
  fix?: boolean;
}

export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('Health-check the wiki for issues')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider')
    .option('--fix', 'Auto-fix issues where possible')
    .action(async (options: LintOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a llmwiki vault. Run `llmwiki init` first.'));
        process.exit(1);
      }

      const providerName = options.provider ?? userConfig.provider ?? 'claude';
      const provider = createProvider(providerName);

      console.log(chalk.blue('Running wiki health check...'));
      console.log();

      const result = await lintWiki(config, provider, { fix: options.fix ?? false });

      if (result.issues.length === 0) {
        console.log(chalk.green('Wiki is healthy! No issues found.'));
      } else {
        console.log(chalk.yellow(`Found ${result.issues.length} issue(s):`));
        console.log();

        for (const issue of result.issues) {
          const icon = issue.severity === 'error' ? chalk.red('x') : chalk.yellow('!');
          console.log(`  ${icon} [${issue.category}] ${issue.message}`);
          if (issue.page) {
            console.log(chalk.dim(`    Page: ${issue.page}`));
          }
          if (issue.fixed) {
            console.log(chalk.green('    -> Fixed'));
          }
        }

        console.log();
        console.log(chalk.dim(`Score: ${result.score}/100`));
      }
    });
}
