import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, basename, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, scryptSync } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { getDefaultAgentsMd } from '../../templates/agents-md.js';
import { getDefaultConfig } from '../../templates/config-yaml.js';
import { setupObsidian } from '../../core/obsidian.js';
import { scanFolder, formatScanSummary } from '../../core/folder-scanner.js';

const INIT_DIR = dirname(fileURLToPath(import.meta.url));
/** Packaged markdown starters for source pages (SUP-001) */
const SOURCE_TYPE_TEMPLATES_DIR = join(INIT_DIR, '../../../templates/source-types');

const DEFAULT_MAX_FILE_SIZE_MB = 50;

interface InitOptions {
  template?: string;
  force?: boolean;
  fromFolder?: string;
  fromRepo?: string;
  interactive?: boolean;
  maxFileSize?: string;
  include?: string;
  exclude?: string;
  keepClone?: boolean;
}

interface FileCategory {
  category: string;
  processable: boolean;
}

const CATEGORY_BY_EXT: Record<string, FileCategory> = {
  '.md': { category: 'documents', processable: true },
  '.txt': { category: 'documents', processable: true },
  '.html': { category: 'documents', processable: true },
  '.htm': { category: 'documents', processable: true },
  '.csv': { category: 'documents', processable: true },
  '.tsv': { category: 'documents', processable: true },
  '.json': { category: 'documents', processable: true },
  '.yaml': { category: 'documents', processable: true },
  '.yml': { category: 'documents', processable: true },
  '.xml': { category: 'documents', processable: true },
  '.pdf': { category: 'pdfs', processable: true },
  '.docx': { category: 'office', processable: true },
  '.doc': { category: 'office', processable: true },
  '.xlsx': { category: 'office', processable: true },
  '.xls': { category: 'office', processable: true },
  '.pptx': { category: 'office', processable: true },
  '.ppt': { category: 'office', processable: true },
  '.png': { category: 'images', processable: true },
  '.jpg': { category: 'images', processable: true },
  '.jpeg': { category: 'images', processable: true },
  '.gif': { category: 'images', processable: true },
  '.webp': { category: 'images', processable: true },
  '.svg': { category: 'images', processable: false },
  '.mp3': { category: 'audio', processable: true },
  '.wav': { category: 'audio', processable: true },
  '.m4a': { category: 'audio', processable: true },
  '.ogg': { category: 'audio', processable: true },
  '.flac': { category: 'audio', processable: true },
  '.mp4': { category: 'video', processable: true },
  '.mov': { category: 'video', processable: true },
  '.avi': { category: 'video', processable: true },
  '.mkv': { category: 'video', processable: true },
  '.webm': { category: 'video', processable: true },
  '.ts': { category: 'code', processable: true },
  '.js': { category: 'code', processable: true },
  '.py': { category: 'code', processable: true },
  '.go': { category: 'code', processable: true },
  '.rs': { category: 'code', processable: true },
  '.java': { category: 'code', processable: true },
  '.c': { category: 'code', processable: true },
  '.cpp': { category: 'code', processable: true },
  '.h': { category: 'code', processable: true },
  '.rb': { category: 'code', processable: true },
  '.php': { category: 'code', processable: true },
  '.swift': { category: 'code', processable: true },
  '.kt': { category: 'code', processable: true },
};

function classify(file: string): FileCategory {
  const ext = extname(file).toLowerCase();
  return CATEGORY_BY_EXT[ext] ?? { category: 'other', processable: false };
}

function parseMaxFileSize(input: string | undefined): number {
  if (!input) return DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --max-file-size: ${input}`);
  }
  return Math.floor(n * 1024 * 1024);
}

/** Convert a shell-style glob to an anchored regex. Supports `*`, `**`, `?`. */
function globToRegex(pattern: string): RegExp {
  let src = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        src += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      src += '[^/]';
      i++;
    } else if ('.+^$()|{}[]\\'.includes(ch)) {
      src += '\\' + ch;
      i++;
    } else {
      src += ch;
      i++;
    }
  }
  return new RegExp('^' + src + '$');
}

function buildGlobPredicate(
  includes: string[] | undefined,
  excludes: string[] | undefined,
): (relPath: string) => boolean {
  const includeRes = (includes ?? []).map(globToRegex);
  const excludeRes = (excludes ?? []).map(globToRegex);
  return (relPath: string) => {
    const normalized = relPath.split('\\').join('/');
    if (excludeRes.some((re) => re.test(normalized))) return false;
    if (includeRes.length === 0) return true;
    return includeRes.some((re) => re.test(normalized));
  };
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
    .option('--from-repo <path-or-url>', 'Create vault from a GitHub repo (URL or local path)')
    .option('--max-file-size <mb>', `Skip files larger than this size in MB (default ${DEFAULT_MAX_FILE_SIZE_MB})`)
    .option('--include <glob>', 'Glob filter for files to include (repeatable, comma-separated)')
    .option('--exclude <glob>', 'Glob filter for files to exclude (repeatable, comma-separated)')
    .option('--keep-clone', 'Keep the temporary git clone after --from-repo completes')
    .action(async (directory: string | undefined, options: InitOptions) => {
      let root = directory ?? '.';
      let template = options.template ?? 'personal';

      if (options.interactive && process.stdin.isTTY) {
        const clack = await import('@clack/prompts');
        clack.intro(chalk.hex('#4f9eff')('wikimem') + chalk.dim(' — interactive setup'));

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

      let maxFileSize: number;
      try {
        maxFileSize = parseMaxFileSize(options.maxFileSize);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (options.fromFolder) {
        await initFromFolder(root, template, options.fromFolder, maxFileSize);
        return;
      }

      if (options.fromRepo) {
        await initFromRepo(root, template, options.fromRepo, {
          maxFileSize,
          include: parseGlobList(options.include),
          exclude: parseGlobList(options.exclude),
          keepClone: options.keepClone ?? false,
        });
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

function parseGlobList(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

async function initFromFolder(
  root: string,
  template: string,
  folderPath: string,
  maxFileSize: number,
): Promise<void> {
  const absFolder = resolve(folderPath);
  if (!existsSync(absFolder)) {
    console.error(chalk.red(`Folder not found: ${absFolder}`));
    process.exit(1);
  }

  console.log(chalk.blue(`Scanning ${absFolder}...`));
  const scan = scanFolder(absFolder, 10_000);

  if (scan.files.length === 0) {
    console.log(chalk.yellow('No supported files found in that folder.'));
    process.exit(1);
  }

  console.log(chalk.green(`  ${formatScanSummary(scan.summary)}`));
  console.log();

  console.log(chalk.blue(`Creating vault in ${root === '.' ? 'current directory' : root}...`));
  scaffoldVault(root, template);

  const rawRoot = join(root, 'raw');
  const copyResult = copyFilesIntoRaw(scan.files, absFolder, rawRoot, maxFileSize);
  console.log(
    chalk.dim(
      `  Copied ${copyResult.copied.length} files into raw/, skipped ${copyResult.oversized.length} oversized, ${copyResult.unprocessable.length} unprocessable.`,
    ),
  );

  if (copyResult.copied.length === 0) {
    console.log(chalk.yellow('\nNo processable files after size + type filter — nothing to ingest.'));
    return;
  }

  console.log();
  console.log(chalk.bold('Starting batch ingest...'));
  console.log(chalk.dim('(This sends each file to your LLM provider for wiki compilation)'));
  console.log();

  await batchIngestCopies(root, copyResult.copied, absFolder);
}

interface CopyOutcome {
  originalPath: string;
  destPath: string;
  relPath: string;
  category: string;
}

interface CopyResult {
  copied: CopyOutcome[];
  oversized: string[];
  unprocessable: string[];
}

function copyFilesIntoRaw(
  files: string[],
  sourceRoot: string,
  rawRoot: string,
  maxFileSize: number,
): CopyResult {
  const copied: CopyOutcome[] = [];
  const oversized: string[] = [];
  const unprocessable: string[] = [];

  for (const abs of files) {
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > maxFileSize) {
      console.log(chalk.yellow(`  skip (too large): ${relative(sourceRoot, abs)} (${Math.round(size / 1024 / 1024)} MB)`));
      oversized.push(abs);
      continue;
    }
    const cls = classify(abs);
    if (!cls.processable) {
      console.log(chalk.dim(`  skip (unprocessable): ${relative(sourceRoot, abs)}`));
      unprocessable.push(abs);
      continue;
    }
    const rel = relative(sourceRoot, abs);
    const dest = join(rawRoot, cls.category, rel);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      copied.push({ originalPath: abs, destPath: dest, relPath: rel, category: cls.category });
    } catch (err) {
      console.log(chalk.yellow(`  copy failed: ${rel} — ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return { copied, oversized, unprocessable };
}

async function batchIngestCopies(
  root: string,
  copies: CopyOutcome[],
  sourceRoot: string,
): Promise<void> {
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const { getVaultConfig } = await import('../../core/vault.js');
    const { ingestSource } = await import('../../core/ingest.js');
    const { createProviderFromUserConfig } = await import('../../providers/index.js');
    const { loadConfig } = await import('../../core/config.js');
    const { recordSnapshot } = await import('../../core/history.js');
    const { loadManifest, saveManifest, recordIngest } = await import('../../core/source-manifest.js');

    const vaultConfig = getVaultConfig(root);
    const userConfig = loadConfig(vaultConfig.configPath);
    const provider = createProviderFromUserConfig(userConfig);
    const manifest = loadManifest(root);

    const total = copies.length;

    for (let i = 0; i < total; i++) {
      const item = copies[i]!;
      const label = item.relPath;
      const progress = chalk.dim(`[${i + 1}/${total}]`);
      const spinner = ora({ text: `${progress} Ingested ${i}/${total} files — ${label}`, color: 'cyan' }).start();

      try {
        const result = await ingestSource(item.destPath, vaultConfig, provider, {
          verbose: false,
          force: false,
          metadata: {
            source_type: 'file',
            original_path: item.originalPath,
            category: item.category,
          },
        });
        if (result.rejected) {
          spinner.warn(`${progress} ${label} — ${chalk.yellow('duplicate, skipped')}`);
          skipped++;
        } else {
          spinner.succeed(`${progress} ${label} → ${chalk.green(`${result.pagesUpdated} pages`)}`);
          recordIngest(manifest, item.originalPath);
          ingested++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail(`${progress} ${label} — ${chalk.red(msg.substring(0, 60))}`);
        errors++;
      }
    }

    try {
      recordSnapshot(vaultConfig, 'ingest', `Batch ingest from ${sourceRoot}: ${ingested} files → wiki pages`);
    } catch { /* non-fatal */ }

    saveManifest(root, manifest);

    console.log();
    console.log(chalk.bold('Results:'));
    console.log(chalk.green(`  scanned: ${total + (total - ingested - skipped - errors < 0 ? 0 : 0)}`));
    console.log(chalk.green(`  ingested: ${ingested}`));
    if (skipped > 0) console.log(chalk.yellow(`  skipped (duplicates): ${skipped}`));
    if (errors > 0) console.log(chalk.red(`  errors: ${errors}`));
    console.log();
    console.log(chalk.cyan('  wikimem serve') + chalk.dim('  — open the web UI'));
    console.log(chalk.cyan('  wikimem status') + chalk.dim(' — see vault statistics'));
    console.log();
    console.log(chalk.dim(`Open in Obsidian: "Open folder as vault" → ${resolve(root)}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`\n  Batch ingest skipped: ${msg}`));
    console.log(chalk.dim('  Files are in raw/ — run `wikimem ingest raw/ --recursive` manually'));
    console.log();
    console.log(chalk.cyan('  wikimem serve') + chalk.dim('  — open the web UI'));
  }
}

interface RepoOptions {
  maxFileSize: number;
  include: string[] | undefined;
  exclude: string[] | undefined;
  keepClone: boolean;
}

async function initFromRepo(
  root: string,
  template: string,
  repoPath: string,
  repoOptions: RepoOptions,
): Promise<void> {
  const isUrl = repoPath.startsWith('http://') || repoPath.startsWith('https://') || repoPath.startsWith('git@');
  let localPath: string;
  let tmpDir: string | undefined;

  if (isUrl) {
    console.log(chalk.blue(`Cloning ${repoPath}...`));
    const { execSync } = await import('node:child_process');
    tmpDir = join(root, '.wikimem-clone-tmp');
    mkdirSync(root, { recursive: true });
    try {
      const cloneUrl = withGitHubToken(repoPath, process.env['GITHUB_TOKEN']);
      execSync(`git clone --depth 1 ${cloneUrl} ${JSON.stringify(tmpDir)}`, { stdio: 'pipe' });
      localPath = tmpDir;
    } catch (err) {
      console.error(chalk.red('Failed to clone repository. Check URL and git access.'));
      if (err instanceof Error && err.message) {
        console.error(chalk.dim(`  ${err.message.substring(0, 200)}`));
      }
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

  const effectiveTemplate = template === 'personal' ? 'codebase' : template;
  scaffoldVault(root, effectiveTemplate);

  const scan = scanFolder(localPath, 5000);
  console.log(chalk.green(`  ${formatScanSummary(scan.summary)}`));

  const predicate = buildGlobPredicate(repoOptions.include, repoOptions.exclude);
  const filtered = scan.files.filter((f) => {
    const rel = relative(localPath, f);
    if (!predicate(rel)) return false;
    const baseName = basename(rel).toLowerCase();
    const isReadmeAtRoot = rel === baseName && baseName.startsWith('readme');
    const isRootMd = rel === baseName && baseName.endsWith('.md');
    const isDocs = rel.startsWith('docs/') || rel.startsWith('docs\\');
    if (repoOptions.include && repoOptions.include.length > 0) return true;
    return isReadmeAtRoot || isRootMd || isDocs || baseName === 'license' || baseName === 'contributing.md';
  });

  if (filtered.length === 0) {
    console.log(chalk.yellow('\nNo README/docs/*.md files matched filters — falling back to scanning root markdown only.'));
    filtered.push(...scan.files.filter((f) => {
      const rel = relative(localPath, f);
      return !rel.includes('/') && rel.toLowerCase().endsWith('.md');
    }));
  }

  const rawRoot = join(root, 'raw');
  const copyResult = copyFilesIntoRaw(filtered, localPath, rawRoot, repoOptions.maxFileSize);

  writeRepositoryOverview(root, localPath, scan.files);

  if (copyResult.copied.length === 0) {
    console.log(chalk.yellow('\nNo files to ingest (all oversized or unprocessable).'));
  } else {
    console.log();
    console.log(chalk.bold('Starting batch ingest...'));
    console.log(chalk.dim('(README and docs will be compiled into wiki pages)'));
    console.log();
    await batchIngestCopies(root, copyResult.copied, localPath);
  }

  if (tmpDir && !repoOptions.keepClone) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  } else if (tmpDir && repoOptions.keepClone) {
    console.log(chalk.dim(`  Clone kept at ${tmpDir}`));
  }

  console.log();
  console.log(chalk.cyan('  wikimem serve') + chalk.dim('       — open the web UI'));
}

function withGitHubToken(url: string, token: string | undefined): string {
  if (!token) return url;
  if (!url.startsWith('https://github.com/')) return url;
  const withoutScheme = url.slice('https://'.length);
  return `https://x-access-token:${token}@${withoutScheme}`;
}

function writeRepositoryOverview(root: string, repoPath: string, files: string[]): void {
  const repoName = basename(resolve(repoPath));
  const now = new Date().toISOString().split('T')[0] ?? '';

  let description = '';
  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { description?: string };
      if (typeof pkg.description === 'string') description = pkg.description.trim();
    } catch { /* ignore */ }
  }
  if (!description) {
    const readme = findReadme(repoPath);
    if (readme) {
      try {
        const text = readFileSync(readme, 'utf-8');
        description = extractFirstParagraph(text);
      } catch { /* ignore */ }
    }
  }

  const tree = buildFileTree(repoPath, 3);
  const languages = summarizeLanguages(files);

  const overviewDir = join(root, 'wiki', 'sources');
  mkdirSync(overviewDir, { recursive: true });
  const overviewPath = join(overviewDir, 'repository-overview.md');

  const body = [
    `---`,
    `title: Repository Overview — ${repoName}`,
    `type: sources`,
    `created: "${now}"`,
    `updated: "${now}"`,
    `tags: [repo, overview, onboarding]`,
    `summary: Auto-generated overview of the ${repoName} repository.`,
    `source_type: repo`,
    `repo_path: ${repoPath}`,
    `---`,
    ``,
    `# Repository Overview — ${repoName}`,
    ``,
    description ? `> ${description}` : `_No description found in README or package.json._`,
    ``,
    `## File Tree (top 3 levels)`,
    ``,
    '```',
    tree,
    '```',
    ``,
    `## Languages`,
    ``,
    languages.length === 0 ? '_No recognized source files detected._' : languages.map((l) => `- ${l.label}: ${l.count} file${l.count === 1 ? '' : 's'}`).join('\n'),
    ``,
  ].join('\n');

  writeFileSync(overviewPath, body, 'utf-8');
}

function findReadme(repoPath: string): string | undefined {
  try {
    const entries = readdirSync(repoPath);
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith('readme')) {
        return join(repoPath, entry);
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function extractFirstParagraph(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('![')) continue;
    if (trimmed.startsWith('[!')) continue;
    if (trimmed.length === 0) {
      if (out.length > 0) break;
      continue;
    }
    out.push(trimmed);
    if (out.join(' ').length > 400) break;
  }
  return out.join(' ').slice(0, 500);
}

function buildFileTree(root: string, maxDepth: number): string {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.wikimem', '.wikimem-cache', '.obsidian']);
  const lines: string[] = [basename(resolve(root)) + '/'];

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    const visible = entries.filter((e) => !e.startsWith('.') && !skip.has(e));
    for (let i = 0; i < visible.length; i++) {
      const name = visible[i]!;
      const full = join(dir, name);
      const isLast = i === visible.length - 1;
      const branch = isLast ? '└── ' : '├── ';
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch { continue; }
      lines.push(prefix + branch + name + (isDir ? '/' : ''));
      if (isDir && depth < maxDepth) {
        walk(full, depth + 1, prefix + (isLast ? '    ' : '│   '));
      }
    }
  }

  walk(root, 1, '');
  return lines.join('\n');
}

interface LanguageStat {
  label: string;
  count: number;
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.c': 'C', '.cpp': 'C++', '.h': 'C/C++ Header',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.md': 'Markdown',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.json': 'JSON',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS',
};

function summarizeLanguages(files: string[]): LanguageStat[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const label = LANG_BY_EXT[ext];
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([label, count]) => ({ label, count }));
}
