import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';
import { getDefaultAgentsMd } from '../../templates/agents-md.js';
import { getDefaultConfig } from '../../templates/config-yaml.js';
import { setupObsidian } from '../../core/obsidian.js';
import { scanFolder, formatScanSummary } from '../../core/folder-scanner.js';

const INIT_DIR = dirname(fileURLToPath(import.meta.url));
/** Packaged markdown starters for source pages (SUP-001) */
const SOURCE_TYPE_TEMPLATES_DIR = join(INIT_DIR, '../../../templates/source-types');

interface InitOptions {
  template?: string;
  force?: boolean;
  fromFolder?: string;
  fromRepo?: string;
  interactive?: boolean;
}

function printBanner(): void {
  console.log();
  console.log(chalk.hex('#4f9eff').bold('  ╦ ╦╦╦╔═╦╔╦╗╔═╗╔╦╗'));
  console.log(chalk.hex('#4f9eff').bold('  ║║║║╠╩╗║║║║║╠═╝║║║'));
  console.log(chalk.hex('#4f9eff').bold('  ╚╩╝╩╩ ╩╩╩ ╩╩╚═╝╩ ╩'));
  console.log(chalk.dim('  self-improving knowledge bases'));
  console.log();
}

function scaffoldVault(root: string, template: string): void {
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

  if (existsSync(SOURCE_TYPE_TEMPLATES_DIR)) {
    const destDir = join(root, 'wiki', '_templates', 'sources');
    mkdirSync(destDir, { recursive: true });
    for (const f of readdirSync(SOURCE_TYPE_TEMPLATES_DIR)) {
      if (f.endsWith('.md')) {
        copyFileSync(join(SOURCE_TYPE_TEMPLATES_DIR, f), join(destDir, f));
      }
    }
  }

  writeFileSync(join(root, 'AGENTS.md'), getDefaultAgentsMd(template), 'utf-8');
  writeFileSync(join(root, 'config.yaml'), getDefaultConfig(template), 'utf-8');

  const now = new Date().toISOString().split('T')[0];
  writeFileSync(
    join(root, 'wiki', 'index.md'),
    `---\ntitle: Wiki Index\ntype: index\ncreated: "${now}"\n---\n\n# Wiki Index\n\n_This index is auto-maintained by wikimem._\n\n## Sources\n\n## Entities\n\n## Concepts\n\n## Syntheses\n`,
    'utf-8',
  );

  writeFileSync(
    join(root, 'wiki', 'log.md'),
    `---\ntitle: Wiki Log\ntype: log\ncreated: "${now}"\n---\n\n# Wiki Log\n\n_Chronological record of wiki operations._\n\n## [${now}] init | Vault created\n\n- Template: ${template}\n`,
    'utf-8',
  );

  setupObsidian(root);

  writeFileSync(
    join(root, '.gitignore'),
    [
      '# wikimem — safe to commit: wiki/ and AGENTS.md only',
      '',
      '# Raw source documents (personal files, PDFs, media — never commit these)',
      'raw/',
      '',
      '# Config may contain API keys',
      'config.yaml',
      '',
      '# Binary / media files that may land outside raw/',
      '*.pdf',
      '*.docx',
      '*.xlsx',
      '*.pptx',
      '*.mp3',
      '*.mp4',
      '*.mov',
      '*.wav',
      '*.m4a',
      '*.jpg',
      '*.jpeg',
      '*.png',
      '*.gif',
      '*.webp',
      '*.zip',
      '',
      '# Environment and secrets',
      '.env',
      '.env.*',
      '',
      '# wikimem internals',
      '.wikimem-cache/',
      '.wikimem/',
      '',
      '# Node',
      'node_modules/',
    ].join('\n') + '\n',
    'utf-8',
  );
}

export function registerInitCommand(program: Command): void {
  program
    .command('init [directory]')
    .description('Create a new wikimem vault')
    .option('-t, --template <template>', 'Domain template (personal, research, business, codebase)', 'personal')
    .option('-f, --force', 'Overwrite existing vault')
    .option('-i, --interactive', 'Interactive template picker (TTY)')
    .option('--from-folder <path>', 'Create vault from existing folder (scan + batch ingest)')
    .option('--from-repo <path-or-url>', 'Create vault from a GitHub repo')
    .action(async (directory: string | undefined, options: InitOptions) => {
      let root = directory ?? '.';
      let template = options.template ?? 'personal';

      if (options.interactive && process.stdin.isTTY) {
        const clack = await import('@clack/prompts');
        clack.intro(chalk.hex('#4f9eff')('wikimem') + chalk.dim(' — interactive setup'));

        // Step 1: Vault name / directory
        if (!directory) {
          const dirChoice = await clack.text({
            message: 'Where should we create your vault?',
            placeholder: './my-wiki',
            defaultValue: '.',
            validate: (v) => {
              if (!v || !v.trim()) return 'Please enter a directory path';
              return undefined;
            },
          });
          if (clack.isCancel(dirChoice)) process.exit(0);
          root = String(dirChoice);
        }

        // Step 2: Template selection
        const choice = await clack.select({
          message: 'Choose a vault template',
          options: [
            { value: 'personal', label: 'Personal', hint: 'Notes & life wiki' },
            { value: 'research', label: 'Research', hint: 'Papers & citations' },
            { value: 'business', label: 'Business', hint: 'Projects & decisions' },
            { value: 'codebase', label: 'Codebase', hint: 'Docs & architecture' },
          ],
          initialValue: 'personal',
        });
        if (clack.isCancel(choice)) process.exit(0);
        template = String(choice);

        // Step 3: LLM Provider
        const providerChoice = await clack.select({
          message: 'Select your LLM provider',
          options: [
            { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'Recommended' },
            { value: 'openai', label: 'OpenAI (GPT-4)', hint: 'gpt-4o / gpt-4o-mini' },
            { value: 'ollama', label: 'Ollama (Local)', hint: 'Free, runs locally' },
            { value: 'skip', label: 'Skip for now', hint: 'Configure later in config.yaml' },
          ],
          initialValue: 'anthropic',
        });
        if (clack.isCancel(providerChoice)) process.exit(0);

        // Step 4: API key (if not ollama/skip)
        let apiKey: string | undefined;
        if (providerChoice !== 'skip' && providerChoice !== 'ollama') {
          const envVar = providerChoice === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
          const existingKey = process.env[envVar];
          if (existingKey) {
            clack.log.success(`Found ${envVar} in environment`);
          } else {
            const keyInput = await clack.password({
              message: `Enter your ${providerChoice === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key`,
              validate: (v) => {
                if (!v || !v.trim()) return 'API key is required (or go back and choose "Skip")';
                return undefined;
              },
            });
            if (clack.isCancel(keyInput)) process.exit(0);
            apiKey = String(keyInput);
          }
        }

        clack.outro(chalk.green('Setting up your vault...'));

        // Store provider/key preferences for config.yaml generation
        if (apiKey || providerChoice === 'ollama') {
          (options as Record<string, unknown>)._provider = String(providerChoice);
          (options as Record<string, unknown>)._apiKey = apiKey;
        }
      }

      if (existsSync(join(root, 'AGENTS.md')) && !options.force) {
        console.error(chalk.red('Vault already exists. Use --force to overwrite.'));
        process.exit(1);
      }

      printBanner();

      if (options.fromFolder) {
        await initFromFolder(root, template, options.fromFolder);
        return;
      }

      if (options.fromRepo) {
        await initFromRepo(root, template, options.fromRepo);
        return;
      }

      console.log(chalk.blue(`Initializing vault in ${root === '.' ? 'current directory' : root} (template: ${template})...`));
      scaffoldVault(root, template);

      const absRoot = resolve(root);
      console.log(chalk.green('✓ Vault initialized successfully!'));
      console.log();
      console.log(chalk.bold('Quick start:'));
      console.log();
      if (root !== '.') {
        console.log(chalk.cyan(`  cd ${root}`));
      }
      console.log(chalk.cyan('  export ANTHROPIC_API_KEY=sk-ant-...'));
      console.log(chalk.cyan('  wikimem ingest <file-or-url>'));
      console.log(chalk.cyan('  wikimem query "your question"'));
      console.log(chalk.cyan('  wikimem serve') + chalk.dim('                       # web UI'));
      console.log();
      console.log(chalk.dim('Open in Obsidian:'));
      console.log(chalk.dim(`  Open Obsidian → "Open folder as vault" → ${absRoot}`));
    });
}

async function initFromFolder(root: string, template: string, folderPath: string): Promise<void> {
  const absFolder = resolve(folderPath);
  if (!existsSync(absFolder)) {
    console.error(chalk.red(`Folder not found: ${absFolder}`));
    process.exit(1);
  }

  console.log(chalk.blue(`Scanning ${absFolder}...`));
  const scan = scanFolder(absFolder);

  if (scan.files.length === 0) {
    console.log(chalk.yellow('No supported files found in that folder.'));
    process.exit(1);
  }

  console.log(chalk.green(`  ${formatScanSummary(scan.summary)}`));
  console.log();

  // Scaffold the vault
  console.log(chalk.blue(`Creating vault in ${root === '.' ? 'current directory' : root}...`));
  scaffoldVault(root, template);

  // Copy files to raw/ with date-stamped directory
  const now = new Date().toISOString().split('T')[0] ?? '';
  const dateDir = join(root, 'raw', now);
  mkdirSync(dateDir, { recursive: true });

  const spinner = ora({ text: 'Copying files to raw/...', color: 'magenta' }).start();
  let copied = 0;
  for (const file of scan.files) {
    try {
      const dest = join(dateDir, basename(file));
      copyFileSync(file, dest);
      copied++;
    } catch {
      // Skip files that can't be copied
    }
  }
  spinner.succeed(`Copied ${copied} files to raw/`);

  // Batch ingest
  console.log();
  console.log(chalk.bold('Starting batch ingest...'));
  console.log(chalk.dim('(This sends each file to your LLM provider for wiki compilation)'));
  console.log();

  try {
    const { getVaultConfig } = await import('../../core/vault.js');
    const { ingestSource } = await import('../../core/ingest.js');
    const { createProviderFromUserConfig } = await import('../../providers/index.js');
    const { loadConfig } = await import('../../core/config.js');
    const { recordSnapshot } = await import('../../core/history.js');

    const vaultConfig = getVaultConfig(root);
    const userConfig = loadConfig(vaultConfig.configPath);
    const provider = createProviderFromUserConfig(userConfig);

    let ingested = 0;
    let skipped = 0;
    let errors = 0;
    const totalFiles = scan.files.length;

    for (let i = 0; i < totalFiles; i++) {
      const file = scan.files[i]!;
      const name = basename(file);
      const progress = chalk.dim(`[${i + 1}/${totalFiles}]`);

      const fileSpinner = ora({ text: `${progress} ${name}`, color: 'cyan' }).start();
      try {
        const destFile = join(dateDir, name);
        const result = await ingestSource(destFile, vaultConfig, provider, {
          verbose: false,
          force: false,
        });
        if (result.rejected) {
          fileSpinner.warn(`${progress} ${name} — ${chalk.yellow('duplicate, skipped')}`);
          skipped++;
        } else {
          fileSpinner.succeed(`${progress} ${name} → ${chalk.green(`${result.pagesUpdated} pages`)}`);
          ingested++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fileSpinner.fail(`${progress} ${name} — ${chalk.red(msg.substring(0, 60))}`);
        errors++;
      }
    }

    // Record history snapshot
    try {
      recordSnapshot(vaultConfig, 'ingest', `Batch ingest from ${absFolder}: ${ingested} files → wiki pages`);
    } catch { /* non-fatal */ }

    console.log();
    console.log(chalk.bold('Results:'));
    console.log(chalk.green(`  ✓ ${ingested} files ingested`));
    if (skipped > 0) console.log(chalk.yellow(`  ⊘ ${skipped} duplicates skipped`));
    if (errors > 0) console.log(chalk.red(`  ✗ ${errors} errors`));
    console.log();
    console.log(chalk.cyan('  wikimem serve') + chalk.dim('  — open the web UI'));
    console.log(chalk.cyan('  wikimem status') + chalk.dim(' — see vault statistics'));
    console.log();
    console.log(chalk.dim(`Open in Obsidian: "Open folder as vault" → ${resolve(root)}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`\n  Batch ingest skipped: ${msg}`));
    console.log(chalk.dim('  Files are in raw/ — run `wikimem ingest` manually'));
    console.log();
    console.log(chalk.cyan('  wikimem serve') + chalk.dim('  — open the web UI'));
  }
}

async function initFromRepo(root: string, template: string, repoPath: string): Promise<void> {
  const isUrl = repoPath.startsWith('http://') || repoPath.startsWith('https://') || repoPath.startsWith('git@');
  let localPath: string;

  if (isUrl) {
    console.log(chalk.blue(`Cloning ${repoPath}...`));
    const { execSync } = await import('node:child_process');
    const tmpDir = join(root, '.wikimem-clone-tmp');
    try {
      execSync(`git clone --depth 1 ${repoPath} ${tmpDir}`, { stdio: 'pipe' });
      localPath = tmpDir;
    } catch {
      console.error(chalk.red('Failed to clone repository. Check URL and git access.'));
      process.exit(1);
    }
  } else {
    localPath = resolve(repoPath);
    if (!existsSync(localPath)) {
      console.error(chalk.red(`Path not found: ${localPath}`));
      process.exit(1);
    }
  }

  console.log(chalk.blue(`Scanning repository at ${localPath}...`));

  // Use codebase template for repos
  const effectiveTemplate = template === 'personal' ? 'codebase' : template;
  scaffoldVault(root, effectiveTemplate);

  // Scan for documentation and code files
  const scan = scanFolder(localPath, 200);
  console.log(chalk.green(`  ${formatScanSummary(scan.summary)}`));

  // Copy key files to raw/
  const now = new Date().toISOString().split('T')[0] ?? '';
  const dateDir = join(root, 'raw', now);
  mkdirSync(dateDir, { recursive: true });

  let copied = 0;
  for (const file of scan.files) {
    try {
      copyFileSync(file, join(dateDir, basename(file)));
      copied++;
    } catch { /* skip */ }
  }

  console.log(chalk.green(`  Copied ${copied} files to raw/`));
  console.log();
  console.log(chalk.cyan('  wikimem ingest raw/') + chalk.dim(' — ingest all files'));
  console.log(chalk.cyan('  wikimem serve') + chalk.dim('       — open the web UI'));

  // Clean up temp clone
  if (isUrl) {
    try {
      const { rmSync } = await import('node:fs');
      rmSync(join(root, '.wikimem-clone-tmp'), { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }
}
