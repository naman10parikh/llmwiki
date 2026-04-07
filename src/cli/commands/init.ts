import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { getDefaultAgentsMd } from '../../templates/agents-md.js';
import { getDefaultConfig } from '../../templates/config-yaml.js';
import { setupObsidian } from '../../core/obsidian.js';

interface InitOptions {
  template?: string;
  force?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init [directory]')
    .description('Create a new wikimem vault')
    .option('-t, --template <template>', 'Domain template (personal, research, business, codebase)', 'personal')
    .option('-f, --force', 'Overwrite existing vault')
    .action(async (directory: string | undefined, options: InitOptions) => {
      const root = directory ?? '.';
      const template = options.template ?? 'personal';

      if (existsSync(join(root, 'AGENTS.md')) && !options.force) {
        console.error(chalk.red('Vault already exists. Use --force to overwrite.'));
        process.exit(1);
      }

      console.log(chalk.blue(`Initializing wikimem vault in ${root} (template: ${template})...`));

      // Create directory structure
      const dirs = [
        join(root, 'raw'),
        join(root, 'wiki'),
        join(root, 'wiki', 'sources'),
        join(root, 'wiki', 'entities'),
        join(root, 'wiki', 'concepts'),
        join(root, 'wiki', 'syntheses'),
      ];

      for (const dir of dirs) {
        mkdirSync(dir, { recursive: true });
      }

      // Write AGENTS.md (schema)
      writeFileSync(join(root, 'AGENTS.md'), getDefaultAgentsMd(template), 'utf-8');

      // Write config.yaml
      writeFileSync(join(root, 'config.yaml'), getDefaultConfig(template), 'utf-8');

      // Write initial index.md
      const now = new Date().toISOString().split('T')[0];
      writeFileSync(
        join(root, 'wiki', 'index.md'),
        `---
title: Wiki Index
type: index
created: "${now}"
---

# Wiki Index

_This index is auto-maintained by llmwiki. Each page is listed with a one-line summary._

## Sources

_No sources ingested yet. Run \`wikimem ingest <file>\` to get started._

## Entities

## Concepts

## Syntheses
`,
        'utf-8',
      );

      // Write initial log.md
      writeFileSync(
        join(root, 'wiki', 'log.md'),
        `---
title: Wiki Log
type: log
created: "${now}"
---

# Wiki Log

_Chronological record of wiki operations. Auto-maintained by llmwiki._

## [${now}] init | Vault created

- Template: ${template}
- Structure: raw/, wiki/ (sources, entities, concepts, syntheses)
`,
        'utf-8',
      );

      // Set up Obsidian config
      setupObsidian(root);

      // Write .gitignore
      writeFileSync(
        join(root, '.gitignore'),
        `# llmwiki
.llmwiki-cache/
node_modules/
`,
        'utf-8',
      );

      const absRoot = resolve(root);
      console.log(chalk.green('Vault initialized successfully!'));
      console.log();
      console.log(chalk.bold('Quick start:'));
      console.log();
      console.log(chalk.white(`  cd ${root}`));
      console.log(chalk.white('  export ANTHROPIC_API_KEY=sk-ant-...  # or OPENAI_API_KEY'));
      console.log(chalk.white('  npx wikimem ingest <file-or-url>'));
      console.log(chalk.white('  npx wikimem query "your question"'));
      console.log(chalk.white('  npx wikimem serve                   # web UI at localhost:3141'));
      console.log();
      console.log(chalk.dim('Open in Obsidian:'));
      console.log(chalk.dim(`  Open Obsidian → "Open folder as vault" → select ${absRoot}`));
      console.log();
      console.log(chalk.dim('Or install globally: npm install -g wikimem'));
    });
}
