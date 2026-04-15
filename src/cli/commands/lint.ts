import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { lintWiki } from '../../core/lint.js';
import { getVaultConfig } from '../../core/vault.js';
import { createProviderFromUserConfig } from '../../providers/index.js';
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
        console.error(chalk.red('Not a wikimem vault. Run `wikimem init` first.'));
        process.exit(1);
      }

      const provider = createProviderFromUserConfig(userConfig, {
        providerOverride: options.provider,
      });

      console.log(chalk.blue('Running wiki health check...'));
      console.log();

      const result = await lintWiki(config, provider, { fix: options.fix ?? false });

      if (result.issues.length === 0) {
        console.log(chalk.green('Wiki is healthy! No issues found.'));
        console.log(chalk.dim(`Score: ${result.score}/100`));
      } else {
        // Group issues by category for a cleaner report
        const grouped = new Map<string, typeof result.issues>();
        for (const issue of result.issues) {
          if (!grouped.has(issue.category)) grouped.set(issue.category, []);
          grouped.get(issue.category)!.push(issue);
        }

        const categoryLabels: Record<string, string> = {
          'orphan': 'Orphan Pages',
          'missing-link': 'Broken Wikilinks',
          'no-summary': 'Missing Summary',
          'no-tldr': 'Missing TLDR (KARP-002)',
          'duplicate-title': 'Duplicate Titles (KARP-005)',
          'malformed-frontmatter': 'Malformed Frontmatter (KARP-005)',
          'empty': 'Empty Pages',
          'contradiction': 'Contradictions',
          'stale': 'Stale Content',
        };

        const errors = result.issues.filter(i => i.severity === 'error').length;
        const warnings = result.issues.filter(i => i.severity === 'warning').length;

        console.log(chalk.yellow(`Found ${result.issues.length} issue(s): ${errors > 0 ? chalk.red(`${errors} errors`) : ''}${errors > 0 && warnings > 0 ? ', ' : ''}${warnings > 0 ? chalk.yellow(`${warnings} warnings`) : ''}`));
        console.log();

        for (const [category, issues] of grouped) {
          const label = categoryLabels[category] ?? category;
          const hasErrors = issues.some(i => i.severity === 'error');
          const header = hasErrors ? chalk.red(`  [${label}]`) : chalk.yellow(`  [${label}]`);
          console.log(header);

          for (const issue of issues) {
            const icon = issue.severity === 'error' ? chalk.red('  x') : chalk.yellow('  !');
            console.log(`${icon} ${issue.message}`);
            if (issue.fixed) {
              console.log(chalk.green('    -> Fixed'));
            }
          }
          console.log();
        }

        console.log(chalk.dim(`Score: ${result.score}/100`));

        const fixable = result.issues.filter(i => i.category === 'no-summary' || i.category === 'orphan' || i.category === 'no-tldr');
        if (!options.fix && fixable.length > 0) {
          console.log();
          console.log(chalk.dim(`${fixable.length} issue(s) auto-fixable: wikimem improve`));
        }
      }
    });
}
