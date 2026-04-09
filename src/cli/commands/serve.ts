import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import chalk from 'chalk';
import { getVaultConfig } from '../../core/vault.js';
import { createServer } from '../../web/server.js';

interface ServeOptions {
  vault?: string;
  port?: string;
}

const REQUIRED_GITIGNORE_ENTRIES = ['raw/', 'config.yaml'];

const GITIGNORE_PRIVACY_BLOCK = `
# wikimem — safe to commit: wiki/ and AGENTS.md only
raw/
config.yaml
*.pdf
*.docx
*.xlsx
*.pptx
*.mp3
*.mp4
*.mov
*.wav
*.jpg
*.jpeg
*.png
*.gif
*.zip
.env
.env.*
.wikimem-cache/
.wikimem/
`;

function ensureGitignore(vaultRoot: string): void {
  const gitignorePath = join(vaultRoot, '.gitignore');

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_PRIVACY_BLOCK.trimStart(), 'utf-8');
    console.log(chalk.yellow('⚠ Created .gitignore to protect raw/ from accidental commits.'));
    return;
  }

  const existing = readFileSync(gitignorePath, 'utf-8');
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));

  if (missing.length > 0) {
    const additions = missing.map((e) => e).join('\n');
    writeFileSync(gitignorePath, `${existing}\n# Added by wikimem serve\n${additions}\n`, 'utf-8');
    console.log(
      chalk.yellow(`⚠ Added missing .gitignore entries to protect private data: ${missing.join(', ')}`),
    );
  }
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the web UI for your knowledge base')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --port <number>', 'Port to listen on', '3141')
    .action((options: ServeOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a wikimem vault. Run `wikimem init` first.'));
        process.exit(1);
      }

      ensureGitignore(vaultRoot);

      const port = parseInt(options.port ?? '3141', 10);
      console.log(chalk.blue('Starting wikimem web UI...'));
      createServer(vaultRoot, port);
    });
}
